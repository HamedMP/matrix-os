"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { palette as c, fonts, radii, statusTones } from "@matrix-os/brand";
import { getGatewayUrl } from "@/lib/gateway";

export type RepoStepProps = {
  title: string;
  status?: "done" | "active" | "pending";
  expanded?: boolean;
  onChange?: () => void;
};

type GithubRepoSummary = {
  nameWithOwner: string;
  url: string;
  description: string | null;
  primaryLanguage: string | null;
  stargazerCount: number;
  updatedAt: string;
};

// Language dot — a minimal colored indicator. Hex values from GitHub's
// canonical language colour list; unknown languages fall back to the
// brand border colour so we never use ad-hoc hex for unsupported names.
const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178C6",
  JavaScript: "#F7DF1E",
  Python: "#3572A5",
  Go: "#00ADD8",
  Rust: "#DEA584",
  Java: "#B07219",
  Ruby: "#701516",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  "C++": "#F34B7D",
  C: "#555555",
  "C#": "#178600",
  PHP: "#4F5D95",
  Dart: "#00B4AB",
  Scala: "#C22D40",
  Shell: "#89E051",
  HTML: "#E34C26",
  CSS: "#563D7C",
};

function langColor(lang: string | null): string {
  if (!lang) return c.border;
  return LANG_COLORS[lang] ?? c.border;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Shared button reset styles for inline buttons so we avoid ad-hoc stacking.
const btnReset: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: 0,
  fontFamily: fonts.sans,
  lineHeight: 1,
};

const cloneBtn: React.CSSProperties = {
  ...btnReset,
  fontSize: 12,
  fontWeight: 500,
  color: c.card,
  background: c.deep,
  borderRadius: radii.pill,
  padding: "4px 11px",
  flexShrink: 0,
  transition: "opacity 0.15s ease",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontFamily: fonts.sans,
  color: c.deep,
  background: c.card,
  border: `1px solid ${c.border}`,
  borderRadius: radii.control,
  padding: "7px 11px",
  outline: "none",
  minWidth: 0,
};

function StepHeader({ title, status }: { title: string; status?: "done" | "active" | "pending" }) {
  const pill =
    status === "done"
      ? { tone: "connected" as const, label: "Done" }
      : status === "active"
        ? { tone: "pending" as const, label: "Up next" }
        : null;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 500, color: c.deep, fontFamily: fonts.sans }}>{title}</span>
      {pill && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: statusTones[pill.tone].bg,
            color: statusTones[pill.tone].fg,
            fontSize: 11,
            fontWeight: 500,
            padding: "4px 9px",
            borderRadius: radii.pill,
          }}
        >
          {pill.label}
        </span>
      )}
    </div>
  );
}

export function RepoStep({ title, status, expanded, onChange }: RepoStepProps) {
  // URL clone form state
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);

  // GitHub repo list state
  const [search, setSearch] = useState("");
  const [repos, setRepos] = useState<GithubRepoSummary[]>([]);
  const [reposError, setReposError] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [cloningRepo, setCloningRepo] = useState<string | null>(null);

  // Scratch project state
  const [scratchLoading, setScratchLoading] = useState(false);
  const [scratchError, setScratchError] = useState<string | null>(null);

  // Fetch GitHub repos whenever the component is expanded or search changes
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!expanded) return;

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    searchDebounceRef.current = setTimeout(() => {
      setReposLoading(true);
      setReposError(null);

      const params = new URLSearchParams({ limit: "25" });
      if (search.trim()) params.set("search", search.trim());

      fetch(`${getGatewayUrl()}/api/github/repos?${params}`, { signal: AbortSignal.timeout(10_000) })
        .then((r) => {
          if (!r.ok) throw new Error("not_ok");
          return r.json() as Promise<{ repos: GithubRepoSummary[] }>;
        })
        .then((data) => {
          setRepos(Array.isArray(data.repos) ? data.repos : []);
        })
        .catch((err: unknown) => {
          // Never surface raw provider error messages.
          const name = err instanceof Error ? err.name : typeof err;
          console.warn("[RepoStep] repos fetch failed:", name);
          setReposError("Could not load repositories. Please try again.");
        })
        .finally(() => setReposLoading(false));
    }, 250);

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [expanded, search]);

  async function postProject(body: Record<string, string>) {
    const r = await fetch(`${getGatewayUrl()}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok && r.status !== 201) throw new Error("not_created");
    return r.status;
  }

  async function handleUrlClone(e: FormEvent) {
    e.preventDefault();
    const url = urlValue.trim();
    if (!url) return;
    setUrlError(null);
    setUrlLoading(true);
    try {
      const status = await postProject({ url });
      if (status === 201 || status === 200) {
        setUrlValue("");
        onChange?.();
      } else {
        setUrlError("Project creation failed. Please try again.");
      }
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : typeof err;
      console.warn("[RepoStep] url clone failed:", name);
      setUrlError("Could not clone the repository. Please check the URL and try again.");
    } finally {
      setUrlLoading(false);
    }
  }

  async function handleRepoClone(repo: GithubRepoSummary) {
    setCloningRepo(repo.nameWithOwner);
    try {
      const status = await postProject({ url: repo.url });
      if (status === 201 || status === 200) {
        onChange?.();
      } else {
        setReposError("Project creation failed. Please try again.");
      }
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : typeof err;
      console.warn("[RepoStep] repo clone failed:", name);
      setReposError("Could not clone the repository. Please try again.");
    } finally {
      setCloningRepo(null);
    }
  }

  async function handleScratch() {
    setScratchError(null);
    setScratchLoading(true);
    const name = `project-${Date.now()}`;
    try {
      const status = await postProject({ mode: "scratch", name });
      if (status === 201 || status === 200) {
        onChange?.();
      } else {
        setScratchError("Could not create the project. Please try again.");
      }
    } catch (err: unknown) {
      const name2 = err instanceof Error ? err.name : typeof err;
      console.warn("[RepoStep] scratch create failed:", name2);
      setScratchError("Could not create an empty project. Please try again.");
    } finally {
      setScratchLoading(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${c.border}`,
    borderRadius: radii.card,
    background: c.card,
    padding: "12px 14px",
    fontFamily: fonts.sans,
  };

  return (
    <div style={cardStyle}>
      <StepHeader title={title} status={status} />

      {expanded && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* URL paste + Clone */}
          <form onSubmit={handleUrlClone} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="url"
              placeholder="https://github.com/owner/repo"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              style={inputStyle}
              aria-label="Repository URL"
            />
            <button
              type="submit"
              disabled={urlLoading || !urlValue.trim()}
              style={{ ...cloneBtn, opacity: urlLoading || !urlValue.trim() ? 0.5 : 1 }}
            >
              {urlLoading ? "Cloning…" : "Clone"}
            </button>
          </form>
          {urlError && (
            <p style={{ margin: 0, fontSize: 12, color: statusTones.pending.fg }}>{urlError}</p>
          )}

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, height: 1, background: c.border }} />
            <span style={{ fontSize: 11, color: c.subtle, whiteSpace: "nowrap" }}>or pick from GitHub</span>
            <div style={{ flex: 1, height: 1, background: c.border }} />
          </div>

          {/* Repo search */}
          <input
            type="search"
            placeholder="Search your repos…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
            aria-label="Search GitHub repositories"
          />

          {/* Repo list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
            {reposLoading && (
              <p style={{ margin: 0, fontSize: 12, color: c.subtle }}>Loading repositories…</p>
            )}
            {!reposLoading && reposError && (
              <p style={{ margin: 0, fontSize: 12, color: statusTones.pending.fg }}>{reposError}</p>
            )}
            {!reposLoading && !reposError && repos.length === 0 && (
              <p style={{ margin: 0, fontSize: 12, color: c.subtle }}>No repositories found.</p>
            )}
            {repos.map((repo) => (
              <div
                key={repo.nameWithOwner}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: radii.control,
                  background: "rgba(67,78,63,0.04)",
                }}
              >
                {/* Language dot */}
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: langColor(repo.primaryLanguage),
                    flexShrink: 0,
                    border: `1px solid rgba(0,0,0,0.08)`,
                  }}
                  title={repo.primaryLanguage ?? "Unknown"}
                  aria-hidden="true"
                />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: c.deep, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {repo.nameWithOwner}
                  </p>
                  {repo.description && (
                    <p style={{ margin: "1px 0 0", fontSize: 11, color: c.subtle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {repo.description}
                    </p>
                  )}
                </div>

                {/* Stars */}
                {repo.stargazerCount > 0 && (
                  <span style={{ fontSize: 11, color: c.mutedFg, flexShrink: 0 }} aria-label={`${repo.stargazerCount} stars`}>
                    ★ {formatStars(repo.stargazerCount)}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => handleRepoClone(repo)}
                  disabled={cloningRepo === repo.nameWithOwner}
                  aria-label={`Clone ${repo.nameWithOwner}`}
                  style={{ ...cloneBtn, opacity: cloningRepo === repo.nameWithOwner ? 0.5 : 1 }}
                >
                  {cloningRepo === repo.nameWithOwner ? "Cloning…" : "Clone"}
                </button>
              </div>
            ))}
          </div>

          {/* Scratch link */}
          <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <button
              type="button"
              onClick={handleScratch}
              disabled={scratchLoading}
              style={{ ...btnReset, fontSize: 12, color: c.subtle, textDecoration: "underline", opacity: scratchLoading ? 0.5 : 1 }}
            >
              {scratchLoading ? "Creating…" : "create an empty project"}
            </button>
            {scratchError && (
              <p style={{ margin: "0 0 0 8px", fontSize: 12, color: statusTones.pending.fg }}>{scratchError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
