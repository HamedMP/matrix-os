# Slice 3 — Setup journey (canvas checklist: agent · GitHub · clone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the post-it `ManualSetupStickers` with a non-blocking, first-class "Set up your workspace" checklist on the first-run canvas — Connect a coding agent → Connect GitHub → Clone or import a repo — wired to existing endpoints plus one new `GET /api/github/repos`, and restyle provisioning onto the brand kit.

**Architecture:** One new gateway endpoint (`GET /api/github/repos`) extends `project-manager` using the existing `gh` CLI pattern. A new `SetupChecklist` shell component composes three step components against existing capabilities: agent status (`/api/agents/credentials/status` + CLI-login terminal launches), GitHub status (`/api/github/status` + `gh auth login --web`), and project creation (`POST /api/projects`, modes `github`/`scratch`) plus the new repos list. Voice/sticker/paste-key screens are retired.

**Tech Stack:** Hono + Zod (gateway), `gh` CLI via `runCommand`, React 19, `@matrix-os/brand`, Vitest (gateway route tests + jsdom/RTL shell tests).

## Global Constraints

- Depends on **Slice 1** (`@matrix-os/brand`). Independent of Slice 2.
- Branch: active onboarding branch / manual worktree. Never commit to `main`.
- New endpoint: authenticated via `requireRequestPrincipal`; Zod-validate query params; outbound `gh` call wrapped with a bounded timeout; never echo provider/raw errors — generic message + server log; cap + paginate results.
- Checklist is **non-blocking**: never gates the canvas; reads/triggers existing capabilities; does not alter `deriveJourneyPhase`.
- No paste-API-key flow — agent auth is CLI-login only.
- All new UI consumes `@matrix-os/brand` (no ad-hoc hex). Replace solid-ember buttons with brand dark/outline.
- React changes → `npx react-doctor@latest shell`. Screenshot evidence for the checklist + each expanded step + provisioning.

---

### Task 1: `GET /api/github/repos` — list the authed user's repos

**Files:**
- Modify: `packages/gateway/src/project-manager.ts` (add `listGithubRepos`)
- Modify: `packages/gateway/src/workspace-routes.ts` (add the route + Zod query schema)
- Test: `tests/gateway/github-repos-route.test.ts`

**Interfaces:**
- Produces:
  - `projectManager.listGithubRepos(opts: { search?: string; limit: number }): Promise<{ repos: GithubRepoSummary[] }>` where `GithubRepoSummary = { nameWithOwner: string; url: string; description: string | null; primaryLanguage: string | null; stargazerCount: number; updatedAt: string }`
  - `GET /api/github/repos?search=&limit=` → `{ repos: GithubRepoSummary[] }`

- [ ] **Step 1: Write the failing route test (mock the project manager)**

```ts
// tests/gateway/github-repos-route.test.ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

function makeApp(listGithubRepos: any) {
  const app = new Hono();
  const projectManager = { listGithubRepos } as any;
  app.route("/", createWorkspaceRoutes({
    projectManager,
    getOwnerScope: () => ({ kind: "user", userId: "user_123" }),
  } as any));
  return app;
}

describe("GET /api/github/repos", () => {
  it("returns a capped, validated repo list", async () => {
    const listGithubRepos = vi.fn(async () => ({ repos: [
      { nameWithOwner: "acme/api", url: "https://github.com/acme/api", description: "API", primaryLanguage: "TypeScript", stargazerCount: 1200, updatedAt: "2026-06-20T00:00:00Z" },
    ] }));
    const app = makeApp(listGithubRepos);
    const res = await app.request("/api/github/repos?search=api&limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos[0].nameWithOwner).toBe("acme/api");
    expect(listGithubRepos).toHaveBeenCalledWith({ search: "api", limit: 10 });
  });

  it("clamps an over-large limit and defaults search", async () => {
    const listGithubRepos = vi.fn(async () => ({ repos: [] }));
    const app = makeApp(listGithubRepos);
    await app.request("/api/github/repos?limit=9999");
    expect(listGithubRepos).toHaveBeenCalledWith({ search: undefined, limit: 50 });
  });

  it("returns a generic 502 when gh fails (no raw error leak)", async () => {
    const listGithubRepos = vi.fn(async () => { throw new Error("gh: secret token in stderr"); });
    const app = makeApp(listGithubRepos);
    const res = await app.request("/api/github/repos");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret token");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/gateway/github-repos-route.test.ts`
Expected: FAIL — route not registered / `listGithubRepos` undefined.

- [ ] **Step 3: Add `listGithubRepos` to `project-manager.ts`**

Mirror the existing `getGithubStatus` `gh` pattern. Add near it:

```ts
export type GithubRepoSummary = {
  nameWithOwner: string;
  url: string;
  description: string | null;
  primaryLanguage: string | null;
  stargazerCount: number;
  updatedAt: string;
};

// inside the object returned by createProjectManager:
    async listGithubRepos(opts: { search?: string; limit: number }): Promise<{ repos: GithubRepoSummary[] }> {
      const args = [
        "repo", "list",
        "--json", "nameWithOwner,url,description,primaryLanguage,stargazerCount,updatedAt",
        "--limit", String(opts.limit),
      ];
      const raw = await runCommand("gh", args, { cwd: homePath, timeout: DEFAULT_TIMEOUT_MS });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("github_repos_unparseable");
      }
      const list = Array.isArray(parsed) ? parsed : [];
      const term = opts.search?.toLowerCase();
      const repos: GithubRepoSummary[] = list
        .map((r: any) => ({
          nameWithOwner: String(r.nameWithOwner ?? ""),
          url: String(r.url ?? ""),
          description: r.description ?? null,
          primaryLanguage: r.primaryLanguage?.name ?? (typeof r.primaryLanguage === "string" ? r.primaryLanguage : null),
          stargazerCount: Number(r.stargazerCount ?? 0),
          updatedAt: String(r.updatedAt ?? ""),
        }))
        .filter((r) => r.nameWithOwner && (!term || r.nameWithOwner.toLowerCase().includes(term)))
        .slice(0, opts.limit);
      return { repos };
    },
```

- [ ] **Step 4: Add the route to `workspace-routes.ts`**

Near the existing `GET /api/github/status` registration:

```ts
  const GithubReposQuerySchema = z.object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  });

  app.get("/api/github/repos", async (c) => {
    requireRequestPrincipal(c, { /* same options object used by getOwnerScope */ });
    const parsed = GithubReposQuerySchema.safeParse({
      search: c.req.query("search"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_query" }, 400);
    }
    try {
      const result = await projectManager.listGithubRepos({
        search: parsed.data.search,
        limit: parsed.data.limit,
      });
      return c.json(result);
    } catch (err: unknown) {
      console.error("[github/repos] list failed:", err instanceof Error ? err.message : typeof err);
      return c.json({ error: "github_unavailable" }, 502);
    }
  });
```

> The `requireRequestPrincipal` options object is the same one `getOwnerScope` builds (line ~237). If the test's injected `getOwnerScope` bypasses principal parsing, gate on it instead; match the existing auth pattern in this file so dev-default/JWT all work.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- tests/gateway/github-repos-route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/project-manager.ts packages/gateway/src/workspace-routes.ts tests/gateway/github-repos-route.test.ts
git commit -m "feat(gateway): list GitHub repos for the setup picker"
```

---

### Task 2: `SetupChecklist` container + persisted progress

**Files:**
- Create: `shell/src/components/onboarding/SetupChecklist.tsx`
- Create: `shell/src/hooks/useSetupChecklist.ts`
- Test: `tests/shell/setup-checklist.test.tsx`

**Interfaces:**
- Produces:
  - `type SetupStepId = "agent" | "github" | "repo"`
  - `useSetupChecklist(): { steps: { id: SetupStepId; status: "done" | "active" | "pending" }[]; activeId: SetupStepId; dismissed: boolean; dismiss(): void; refresh(): void }`
  - `SetupChecklist({ onOpenTerminal }: { onOpenTerminal: (path: string) => void })` — docked brand card; renders the three step components; `N of 3` progress; "Skip for now".

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installMocks(agentConnected: boolean, githubAuthed: boolean) {
  vi.doMock("@clerk/nextjs", () => ({ useUser: () => ({ user: { publicMetadata: {} } }) }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes("/api/agents/credentials/status")) return new Response(JSON.stringify({ agents: [{ id: "claude", available: agentConnected }] }), { status: 200 });
    if (u.includes("/api/github/status")) return new Response(JSON.stringify({ installed: true, authenticated: githubAuthed, user: githubAuthed ? "hamedmp" : null }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

async function load() { vi.resetModules(); return await import("../../shell/src/components/onboarding/SetupChecklist.js"); }

describe("SetupChecklist", () => {
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it("renders the three steps and a 'Set up your workspace' header", async () => {
    installMocks(false, false);
    const { SetupChecklist } = await load();
    render(<SetupChecklist onOpenTerminal={() => {}} />);
    expect(screen.getByText("Set up your workspace")).toBeTruthy();
    expect(screen.getByText(/Connect a coding agent/i)).toBeTruthy();
    expect(screen.getByText(/Connect GitHub/i)).toBeTruthy();
    expect(screen.getByText(/Clone or import a repo/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/shell/setup-checklist.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the hook**

```ts
// shell/src/hooks/useSetupChecklist.ts
import { useCallback, useEffect, useState } from "react";

export type SetupStepId = "agent" | "github" | "repo";
type Status = "done" | "active" | "pending";

const DISMISS_KEY = "matrix:setup-checklist-dismissed";

export function useSetupChecklist() {
  const [agentDone, setAgentDone] = useState(false);
  const [githubDone, setGithubDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(() => {
    void fetch("/api/agents/credentials/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAgentDone(Boolean(d?.agents?.some((a: any) => a.available))))
      .catch((err: unknown) => console.warn("[setup] agent status failed:", err instanceof Error ? err.name : typeof err));
    void fetch("/api/github/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGithubDone(Boolean(d?.authenticated)))
      .catch((err: unknown) => console.warn("[setup] github status failed:", err instanceof Error ? err.name : typeof err));
    void fetch("/api/workspace/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRepoDone(Array.isArray(d?.projects) ? d.projects.length > 0 : false))
      .catch((err: unknown) => console.warn("[setup] projects failed:", err instanceof Error ? err.name : typeof err));
  }, []);

  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1"); } catch { /* sandbox: ignore */ }
    refresh();
  }, [refresh]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* sandbox: ignore */ }
  }, []);

  const done: Record<SetupStepId, boolean> = { agent: agentDone, github: githubDone, repo: repoDone };
  const order: SetupStepId[] = ["agent", "github", "repo"];
  const activeId = order.find((id) => !done[id]) ?? "repo";
  const steps = order.map((id) => ({
    id,
    status: (done[id] ? "done" : id === activeId ? "active" : "pending") as Status,
  }));

  return { steps, activeId, dismissed, dismiss, refresh };
}
```

- [ ] **Step 4: Implement the container** (composes the step components from Tasks 3–5; for this task they may be inline placeholders that Tasks 3–5 replace)

```tsx
// shell/src/components/onboarding/SetupChecklist.tsx
import { palette as c, fonts } from "@matrix-os/brand";
import { useSetupChecklist, type SetupStepId } from "@/hooks/useSetupChecklist";
import { AgentStep } from "./steps/AgentStep";
import { GithubStep } from "./steps/GithubStep";
import { RepoStep } from "./steps/RepoStep";

const STEP_META: Record<SetupStepId, { title: string }> = {
  agent: { title: "Connect a coding agent" },
  github: { title: "Connect GitHub" },
  repo: { title: "Clone or import a repo" },
};

export function SetupChecklist({ onOpenTerminal }: { onOpenTerminal: (path: string) => void }) {
  const { steps, activeId, dismissed, dismiss, refresh } = useSetupChecklist();
  if (dismissed) return null;
  const doneCount = steps.filter((s) => s.status === "done").length;

  return (
    <div style={{ maxWidth: 400, background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, boxShadow: "0 24px 60px rgba(50,53,46,0.12)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div>
          <p style={{ fontFamily: fonts.display, fontSize: 25, lineHeight: 1.05, color: c.deep, margin: 0 }}>Set up your workspace</p>
          <p style={{ fontSize: 12, color: c.subtle, marginTop: 3 }}>Explore the canvas anytime — this stays here until you're done.</p>
        </div>
        <span style={{ fontSize: 11, fontWeight: 500, color: c.mutedFg, whiteSpace: "nowrap", background: "rgba(67,78,63,0.06)", padding: "5px 9px", borderRadius: 999 }}>{doneCount} of 3</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 15 }}>
        <AgentStep status={steps[0].status} expanded={activeId === "agent"} title={STEP_META.agent.title} onOpenTerminal={onOpenTerminal} onChange={refresh} />
        <GithubStep status={steps[1].status} expanded={activeId === "github"} title={STEP_META.github.title} onOpenTerminal={onOpenTerminal} onChange={refresh} />
        <RepoStep status={steps[2].status} expanded={activeId === "repo"} title={STEP_META.repo.title} onChange={refresh} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 15, paddingTop: 13, borderTop: `1px solid ${c.border}` }}>
        <button type="button" onClick={dismiss} style={{ fontSize: 12, color: c.subtle, background: "none", border: "none", cursor: "pointer" }}>Skip for now</button>
      </div>
    </div>
  );
}
```

> Tasks 3–5 create `steps/AgentStep.tsx`, `steps/GithubStep.tsx`, `steps/RepoStep.tsx`. To keep this task independently testable, first create minimal stub step components that render `<div>{title}</div>` inside a brand card, then Tasks 3–5 flesh them out. The Task 2 test only asserts titles render.

- [ ] **Step 5: Create the three stub step files** (minimal, replaced in Tasks 3–5)

For each of `shell/src/components/onboarding/steps/{AgentStep,GithubStep,RepoStep}.tsx`, a stub:

```tsx
import { palette as c } from "@matrix-os/brand";
export function AgentStep({ title }: { title: string; status?: string; expanded?: boolean; onOpenTerminal?: (p: string) => void; onChange?: () => void }) {
  return <div style={{ border: `1px solid ${c.border}`, borderRadius: 11, background: c.card, padding: 12, fontSize: 14, color: c.deep }}>{title}</div>;
}
```

(Same shape for `GithubStep` and `RepoStep`, adjusting the export name and props.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test -- tests/shell/setup-checklist.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shell/src/components/onboarding/SetupChecklist.tsx shell/src/hooks/useSetupChecklist.ts shell/src/components/onboarding/steps tests/shell/setup-checklist.test.tsx
git commit -m "feat(shell): non-blocking Set up your workspace checklist"
```

---

### Task 3: AgentStep — status + CLI-login (no paste-key)

**Files:**
- Modify (replace stub): `shell/src/components/onboarding/steps/AgentStep.tsx`
- Test: `tests/shell/setup-step-agent.test.tsx`

**Interfaces:**
- Consumes: existing `useAgentCredentialStatus` hook (or `GET /api/agents/credentials/status`); existing terminal-launch paths `claude-login`, `codex-login` via `onOpenTerminal(createTerminalLaunchPath(id))`.
- Behavior: rows for Claude / Codex / Hermes; available → `StatusPill connected`; missing → outline "Connect" that calls `onOpenTerminal`. Hermes always "Ready".

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/lib/terminal-launch", () => ({ createTerminalLaunchPath: (id: string) => `__terminal__:${id}` }));

async function load() { vi.resetModules(); return await import("../../shell/src/components/onboarding/steps/AgentStep.js"); }

describe("AgentStep", () => {
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); calls.opened = []; });
  afterEach(() => vi.restoreAllMocks());

  it("launches Codex CLI login when Connect is clicked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ agents: [{ id: "claude", available: true }, { id: "codex", available: false }] }), { status: 200 }));
    const { AgentStep } = await load();
    render(<AgentStep title="Connect a coding agent" status="active" expanded onOpenTerminal={(p) => calls.opened.push(p)} onChange={() => {}} />);
    const connect = await screen.findByRole("button", { name: /connect/i });
    fireEvent.click(connect);
    expect(calls.opened.some((p) => p.includes("codex-login"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `bun run test -- tests/shell/setup-step-agent.test.tsx` (FAIL: stub has no button).

- [ ] **Step 3: Implement `AgentStep`** — a brand step card with a header (icon dot, title, sub, status), and when expanded, three agent rows. Claude/Codex read `available` from the status fetch; "Connect" calls `onOpenTerminal(createTerminalLaunchPath("codex-login"))` (or `claude-login`). Use `StatusPill` from `@matrix-os/brand`. After launching, call `onChange()` so the checklist re-polls. (Full component mirrors the approved mockup: rows with `aria-pressed`/role button for Connect.)

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(shell): agent setup step wired to status + CLI login`.

---

### Task 4: GithubStep — status + `gh auth login --web`

**Files:**
- Modify (replace stub): `shell/src/components/onboarding/steps/GithubStep.tsx`
- Test: `tests/shell/setup-step-github.test.tsx`

**Interfaces:**
- Consumes: `GET /api/github/status`; existing `createTerminalLaunchPath("github-ssh-login")`.
- Behavior: shows scopes + "Authorize GitHub" (dark button) → `onOpenTerminal(createTerminalLaunchPath("github-ssh-login"))`; when `authenticated`, header shows `@user` + connected pill.

- [ ] **Step 1: Write the failing test** — mock `/api/github/status` returning `{authenticated:false}`; click "Authorize GitHub" → asserts `onOpenTerminal` called with a path containing `github-ssh-login`. Second case: `{authenticated:true,user:"hamedmp"}` → renders `@hamedmp`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `GithubStep`** per the approved mockup (scope list, authorize button, terminal fallback link), consuming `@matrix-os/brand`.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** `feat(shell): GitHub setup step (authorize via gh)`.

---

### Task 5: RepoStep — paste URL · pick from GitHub · scratch

**Files:**
- Modify (replace stub): `shell/src/components/onboarding/steps/RepoStep.tsx`
- Test: `tests/shell/setup-step-repo.test.tsx`

**Interfaces:**
- Consumes: `GET /api/github/repos` (Task 1); `POST /api/projects` (`{ url }` → clone, `{ mode: "scratch", name }` → empty).
- Behavior: a URL input + Clone (POST `{url}`); a searchable repo list from `/api/github/repos` with per-row Clone (POST `{url}`); "create an empty project" (POST `{mode:"scratch"}`). On success call `onChange()`.

- [ ] **Step 1: Write the failing test** — mock `/api/github/repos` → one repo; render expanded; assert the repo row renders; click its Clone → asserts a `POST /api/projects` with that `url`; assert `onChange` fires on 201.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `RepoStep`** per the approved mockup (URL field + Clone, divider, search + repo rows with language dot/stars/Clone, "create an empty project"). Use `AbortSignal.timeout(30_000)` on the clone POST (file download tier), `10_000` on the repos GET. Surface a generic error string on failure (no raw provider text).

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** `feat(shell): clone/import repo setup step`.

---

### Task 6: Mount on first-run canvas; retire stickers + paste-key

**Files:**
- Modify: the first-run render site (locate via grep — likely `shell/src/components/Desktop.tsx` and/or the canvas first-run layer that renders `ManualSetupStickers`)
- Delete/retire: `shell/src/components/onboarding/ManualSetupStickers.tsx`, `shell/src/components/onboarding/ApiKeyInput.tsx`, and the ad-hoc `AgentCredentialPanel.tsx` (superseded by `AgentStep`) — remove imports/usages
- Test: `tests/shell/first-run-setup-mount.test.tsx` (or extend an existing Desktop/canvas test)

- [ ] **Step 1: Locate the mount + usages**

Run: `grep -rn "ManualSetupStickers\|ApiKeyInput\|AgentCredentialPanel" shell/src`
Note every render/import site.

- [ ] **Step 2: Write the failing test** — assert the first-run surface renders `SetupChecklist` (by its "Set up your workspace" text) and no longer imports `ManualSetupStickers`. Match the house pattern of the existing Desktop/canvas test (RTL render or source-text assertion, whichever the neighbor test uses).

- [ ] **Step 3: Swap the mount** — replace `<ManualSetupStickers .../>` with `<SetupChecklist onOpenTerminal={openTerminal} />` (reuse the existing `onOpenTerminal`/terminal-launch handler the stickers used). Remove now-dead imports. Delete the retired files once no references remain (verify with the Step 1 grep returning clean).

- [ ] **Step 4: Run the test + typecheck** → `bun run test -- tests/shell/first-run-setup-mount.test.tsx && bun run typecheck` (Expected: PASS; no dangling imports).

- [ ] **Step 5: Commit** `feat(shell): mount setup checklist on first-run; retire stickers + paste-key`.

---

### Task 7: Provisioning restyle on the brand kit

**Files:**
- Modify: `shell/src/components/BootSequence.tsx` (replace solid-ember CTA buttons with brand dark/outline; serif phase title; thin progress where applicable)
- Test: `tests/shell/boot-sequence-brand.test.tsx` (or source-text assertion)

- [ ] **Step 1: Write the failing test** — assert `BootSequence.tsx` no longer uses `bg-ember px-4 py-2` solid CTAs for `plan_required`/`provisioning_failed`, and that primary actions use the brand button styling (e.g. imports from `@matrix-os/brand` or the `deep`-bg style). Keep it a source-text assertion to avoid over-coupling.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — swap the `plan_required` "View plans" and `provisioning_failed` retry buttons to the brand dark/outline style; set phase titles in `fonts.display`; keep all journey logic untouched (presentation only).

- [ ] **Step 4: Run to verify it passes + the existing BootSequence tests stay green** → `bun run test -- tests/shell/boot-sequence-brand.test.tsx` and any existing `tests/shell/*boot*`/journey tests.

- [ ] **Step 5: Commit** `feat(shell): provisioning states on the brand kit`.

---

### Task 8: Top-bar segmented mode switcher (replace dock control)

**Files:**
- Modify: `shell/src/stores/desktop-mode.ts` (add `icon: LucideIcon` to `ModeConfig` + each config)
- Create: `shell/src/components/ModeSwitcherBar.tsx` (segmented control)
- Modify: `shell/src/components/MenuBar.tsx` (render `ModeSwitcherBar`)
- Modify: `shell/src/components/Desktop.tsx` (remove the dock `<ModeSwitcher>` usage + the `ModeSwitcher` component + now-unused imports)
- Test: `tests/shell/mode-switcher-bar.test.tsx`

**Interfaces:**
- `ModeConfig` gains `icon: LucideIcon`.
- Produces: `ModeSwitcherBar()` — a segmented control over `visibleModes()` (Developer, Canvas); each pill = `icon` + `label`; active pill raised; `onClick` → `setMode(id)`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load() { vi.resetModules(); return await import("../../shell/src/components/ModeSwitcherBar.js"); }

describe("ModeSwitcherBar", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => vi.restoreAllMocks());

  it("renders both visible modes and marks the active one", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    useDesktopMode.setState({ mode: "dev" });
    const { ModeSwitcherBar } = await load();
    render(<ModeSwitcherBar />);
    expect(screen.getByRole("button", { name: /developer/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /canvas/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("switches mode on click", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    useDesktopMode.setState({ mode: "dev" });
    const { ModeSwitcherBar } = await load();
    render(<ModeSwitcherBar />);
    fireEvent.click(screen.getByRole("button", { name: /canvas/i }));
    expect(useDesktopMode.getState().mode).toBe("canvas");
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `bun run test -- tests/shell/mode-switcher-bar.test.tsx` (FAIL: component + `icon` field missing).

- [ ] **Step 3: Add `icon` to `ModeConfig`** — in `shell/src/stores/desktop-mode.ts`:

```ts
import { TerminalIcon, LayoutGridIcon, MonitorIcon, AudioWaveformIcon, type LucideIcon } from "lucide-react";
```

Add `icon: LucideIcon;` to `ModeConfig`, and set per config: `canvas → LayoutGridIcon`, `dev → TerminalIcon`, `desktop → MonitorIcon`, `ambient → AudioWaveformIcon`. (Configs are static constants, not persisted state, so a component reference is safe.)

- [ ] **Step 4: Implement `ModeSwitcherBar`**

```tsx
// shell/src/components/ModeSwitcherBar.tsx
"use client";

import { useDesktopMode } from "@/stores/desktop-mode";

export function ModeSwitcherBar() {
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const modes = useDesktopMode((s) => s.visibleModes)();

  return (
    <div className="inline-flex items-center gap-0.5 rounded-[9px] border border-border bg-foreground/[0.04] p-0.5">
      {modes.map((m) => {
        const Icon = m.icon;
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={active}
            aria-label={`${m.label} mode`}
            onClick={() => setMode(m.id)}
            title={m.description}
            className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-[14px]" aria-hidden="true" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Render it in the top bar** — add `<ModeSwitcherBar />` to `MenuBar.tsx` (left/center region, after the logo group) and import it.

- [ ] **Step 6: Remove the dock control** — in `Desktop.tsx`, delete the `<ModeSwitcher … />` usage (~line 1725), the `ModeSwitcher` function (~lines 419–511), and any now-unused imports (`MonitorIcon`/`CheckIcon`) only if no longer referenced. `grep -n "ModeSwitcher\b" shell/src/components/Desktop.tsx` → expect no remaining references.

- [ ] **Step 7: Run tests + typecheck** → `bun run test -- tests/shell/mode-switcher-bar.test.tsx && bun run typecheck` (PASS; no dangling imports). Re-run any existing Desktop/dock test to confirm removing the dock switcher caused no regression.

- [ ] **Step 8: Commit** `feat(shell): top-bar segmented mode switcher; remove dock control`.

---

### Task 9: Verification

- [ ] **Step 1: Full suite for touched areas** → `bun run test -- tests/gateway/github-repos-route.test.ts tests/shell` (Expected: PASS).
- [ ] **Step 2: Typecheck + patterns** → `bun run typecheck && bun run check:patterns` (Expected: clean; verify the new `gh` call has a timeout, the route returns generic errors, no bare catch).
- [ ] **Step 3: React audit** → `npx react-doctor@latest shell` (resolve findings).
- [ ] **Step 4: Screenshots** — with the Docker stack (`:3000`), capture: first-run canvas + checklist, each expanded step (agent/github/repo), provisioning, and the top-bar mode switcher in both Developer and Canvas states. Save under `specs/099-onboarding-journey/`.
- [ ] **Step 5: Commit evidence** → `docs(099): setup journey slice verification evidence`.

## Self-Review

- **Spec coverage:** Parent screens 4 (provisioning → Task 7), 5 (canvas checklist → Task 2/6), 6 (agent → Task 3), 7 (GitHub → Task 4), 8 (clone → Task 5 + endpoint Task 1), 9 (top-bar mode switcher → Task 8). Backend "one new endpoint" → Task 1. Retire voice/sticker/paste-key → Task 6. Remove dock mode control → Task 8.
- **Placeholders:** Tasks 3–5 describe full components by reference to the approved mockups and provide complete tests + interfaces; the stub→flesh sequencing (Task 2 Step 5 → Tasks 3–5) is explicit, not a TODO. The single discovery step (Task 6 Step 1, mount site) is a verification action, not a placeholder.
- **Type consistency:** `SetupStepId` (`agent|github|repo`), `GithubRepoSummary` fields, and the status union (`done|active|pending`) are used identically across the hook, container, steps, and endpoint. `onOpenTerminal`/`createTerminalLaunchPath` signatures match the existing terminal-launch module.
