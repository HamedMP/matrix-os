import {
  CollaborationProjectOverviewSchema,
  CollaborationScopeSchema,
  type CollaborationProjectOverview,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

type Role = "owner" | "editor" | "viewer";

/**
 * A shared project inside the Chats app: its name, the member's role, and its Chats. Each Chat
 * opens in place through its own scope; access to it comes from the project.
 */
export function SharedProjectView({ api, scopeId, openChat }: {
  api: CollaborationApi;
  scopeId: string;
  openChat: (scopeId: string, chatId?: string, title?: string) => void;
}) {
  const [value, setValue] = useState<{ role: Role; overview: CollaborationProjectOverview } | null>(null);
  const [failed, setFailed] = useState(false);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
    try {
      const [scopeValue, overviewValue] = await Promise.all([api.get(base), api.get(`${base}/project/overview`)]);
      const scope = CollaborationScopeSchema.parse(scopeValue);
      const overview = CollaborationProjectOverviewSchema.parse(overviewValue);
      if (scope.kind !== "project" || overview.scopeId !== scope.id || overview.projectId !== scope.resourceId) {
        throw new Error("Project scope mismatch");
      }
      if (generation === loadGeneration.current) {
        setValue({ role: scope.role, overview });
        setFailed(false);
      }
    } catch (error: unknown) {
      console.warn("[project-collaboration] project load failed", error instanceof Error ? error.name : "UnknownError");
      if (generation === loadGeneration.current) {
        setValue(null);
        setFailed(true);
      }
      throw error;
    }
  }, [api, scopeId]);
  useEffect(() => {
    setValue(null);
    setFailed(false);
    void load().catch((error: unknown) => {
      console.warn("[project-collaboration] initial load unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => api.subscribe?.(scopeId, load, () => {
    loadGeneration.current += 1;
    setValue(null);
    setFailed(true);
  }), [api, load, scopeId]);

  if (failed) {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      <div aria-hidden className="text-3xl">◇</div><h1 className="mt-3 text-lg font-medium">Shared project unavailable</h1>
      <p className="mt-1 text-sm">Your access may have changed. Return to Shared with me and refresh.</p>
    </div>;
  }
  if (!value) return <p role="status" className="p-8">Loading shared project…</p>;
  const { role, overview } = value;
  return <main data-slot="shared-project" className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 p-5 sm:p-8">
    <header className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-xl font-semibold">{overview.name}</h1>
        <SharedMark />
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        {roleLabel(role)} · {role === "viewer" ? "read only" : "can edit"}
      </p>
    </header>
    {overview.status === "archived" ? <p role="status" className="rounded-xl border p-4 text-sm">This project is archived.</p> : null}
    <section aria-labelledby="shared-project-chats" className="min-w-0">
      <h2 id="shared-project-chats" className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
        Chats
      </h2>
      {overview.chats.length === 0
        ? <div className="mt-3 rounded-2xl border p-6 text-center">
          <div aria-hidden className="text-2xl">◇</div>
          <p className="mt-2 font-medium">No Chats yet</p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Chats in this project appear here as soon as they are added.</p>
        </div>
        : <ul className="mt-2 flex flex-col gap-1">
          {overview.chats.map((chat) => <li key={chat.scopeId}>
            <button type="button"
              className="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-hover)]"
              onClick={() => openChat(chat.scopeId, chat.chatId, chat.title)}>
              <span className="truncate font-medium">{chat.title}</span>
              <time dateTime={chat.updatedAt} className="shrink-0 text-xs" style={{ color: "var(--text-secondary)" }}>
                {formatUpdatedAt(chat.updatedAt)}
              </time>
            </button>
          </li>)}
        </ul>}
    </section>
  </main>;
}

/** The one cue that sets a shared project apart from the member's own projects. */
function SharedMark() {
  return <span role="img" aria-label="Shared project" title="Shared with you" className="inline-flex shrink-0" style={{ color: "var(--text-secondary)" }}>
    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  </span>;
}

function roleLabel(role: Role): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

const updatedAtFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatUpdatedAt(value: string): string {
  return updatedAtFormat.format(new Date(value));
}
