import { useEffect, useState } from "react";
import { palette as c, fonts, radii, statusTones } from "@matrix-os/brand";
import { StatusPill } from "@matrix-os/brand";
import { getGatewayUrl } from "@/lib/gateway";
import { createTerminalLaunchPath } from "@/lib/terminal-launch";

interface GithubStatus {
  installed: boolean;
  authenticated: boolean;
  user: string | null;
  errorCode?: string;
}

interface GithubStepProps {
  title: string;
  status?: "done" | "active" | "pending";
  expanded?: boolean;
  onOpenTerminal?: (path: string) => void;
  onChange?: () => void;
}

const SCOPE_LIST = [
  "Read and write your repositories",
  "Open and merge pull requests on your behalf",
  "SSH keys stay local — never uploaded to Matrix",
];

export function GithubStep({
  title,
  status = "pending",
  expanded = false,
  onOpenTerminal,
  onChange,
}: GithubStepProps) {
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);

  useEffect(() => {
    void fetch(`${getGatewayUrl()}/api/github/status`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GithubStatus | null) => {
        setGithubStatus(d);
        if (d?.authenticated && onChange) onChange();
      })
      .catch((err: unknown) => {
        console.warn("[GithubStep] status fetch failed:", err instanceof Error ? err.name : typeof err);
      });
  }, [onChange]);

  const authenticated = githubStatus?.authenticated ?? false;
  const user = githubStatus?.user ?? null;

  function handleAuthorize() {
    if (!onOpenTerminal) return;
    onOpenTerminal(createTerminalLaunchPath("github-ssh-login"));
  }

  const pillTone: keyof typeof statusTones =
    status === "done" ? "connected" : status === "active" ? "pending" : "pending";

  const headerBg =
    status === "done"
      ? statusTones.connected.bg
      : status === "active"
        ? "transparent"
        : "transparent";

  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: radii.card,
        background: c.card,
        overflow: "hidden",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "12px 14px",
          background: headerBg,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontFamily: fonts.sans,
              fontSize: 14,
              fontWeight: 500,
              color: c.deep,
              margin: 0,
              lineHeight: 1.25,
            }}
          >
            {title}
          </p>
          {authenticated && user ? (
            <p style={{ fontSize: 12, color: c.subtle, margin: "2px 0 0", fontFamily: fonts.sans }}>
              @{user}
            </p>
          ) : (
            <p style={{ fontSize: 12, color: c.subtle, margin: "2px 0 0", fontFamily: fonts.sans }}>
              Authorize with your GitHub account
            </p>
          )}
        </div>

        {authenticated ? (
          <StatusPill tone="connected">Connected</StatusPill>
        ) : status === "done" ? (
          <StatusPill tone="connected">Done</StatusPill>
        ) : null}
      </div>

      {/* Expanded body — only when active and not yet authenticated */}
      {expanded && !authenticated && (
        <div
          style={{
            padding: "0 14px 14px",
            borderTop: `1px solid ${c.border}`,
          }}
        >
          {/* Scope list */}
          <ul
            style={{
              margin: "12px 0 14px",
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 7,
            }}
          >
            {SCOPE_LIST.map((item) => (
              <li
                key={item}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: 13,
                  color: c.mutedFg,
                  fontFamily: fonts.sans,
                  lineHeight: 1.4,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: statusTones.connected.bg,
                    color: statusTones.connected.fg,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    marginTop: 1,
                  }}
                >
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>

          {/* Authorize button */}
          <button
            type="button"
            onClick={handleAuthorize}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 16px",
              background: c.deep,
              color: "#FAFAF5",
              border: `1px solid ${c.deep}`,
              borderRadius: radii.control,
              fontFamily: fonts.sans,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            Authorize GitHub
          </button>

          {/* SSH fallback */}
          <p style={{ textAlign: "center", marginTop: 10, marginBottom: 0 }}>
            <button
              type="button"
              onClick={handleAuthorize}
              style={{
                background: "none",
                border: "none",
                fontSize: 12,
                color: c.subtle,
                cursor: "pointer",
                fontFamily: fonts.sans,
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Set up SSH in the terminal
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
