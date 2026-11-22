import { beforeEach, describe, expect, it } from "vitest";
import {
  CLOSED_APPS_LIMIT,
  recordClosedApp,
  useClosedApps,
} from "@desktop/renderer/src/stores/closed-apps";
import { useTabs, type Tab } from "@desktop/renderer/src/stores/tabs";

function tab(overrides: Partial<Tab> = {}): Tab {
  return { id: "tab-x", kind: "files", title: "Files", closable: true, ...overrides };
}

beforeEach(() => {
  useClosedApps.setState(useClosedApps.getInitialState(), true);
  useTabs.setState(useTabs.getInitialState(), true);
});

describe("closed apps store", () => {
  it("returns null when nothing has been closed", () => {
    expect(useClosedApps.getState().pop()).toBeNull();
  });

  it("pops the most recently closed app first and drops tab identity", () => {
    useClosedApps.getState().push(tab({ id: "a", slug: "first" }));
    useClosedApps.getState().push(tab({ id: "b", slug: "docs" }));

    const spec = useClosedApps.getState().pop();
    expect(spec).toEqual({ kind: "files", title: "Files", slug: "docs", closable: true });
    expect(spec).not.toHaveProperty("id");
    expect(useClosedApps.getState().pop()).toMatchObject({ slug: "first" });
    expect(useClosedApps.getState().pop()).toBeNull();
  });

  it("keeps only the newest entries when more than the limit are pushed", () => {
    for (let index = 0; index < CLOSED_APPS_LIMIT + 1; index += 1) {
      useClosedApps.getState().push(tab({ id: `t${index}`, slug: `s${index}` }));
    }

    const { entries } = useClosedApps.getState();
    expect(CLOSED_APPS_LIMIT).toBe(10);
    expect(entries).toHaveLength(10);
    expect(entries.some((entry) => entry.slug === "s0")).toBe(false);
    expect(useClosedApps.getState().pop()).toMatchObject({ slug: "s10" });
  });

  it("forgets terminal session names so a reopened terminal starts a new session", () => {
    useClosedApps.getState().push(tab({ id: "t1", kind: "terminal", title: "build", sessionName: "build-1" }));
    useClosedApps.getState().push(tab({ id: "t2", kind: "terminals", title: "Terminal", sessionName: "main" }));

    const terminals = useClosedApps.getState().pop();
    const terminal = useClosedApps.getState().pop();
    expect(terminals).not.toHaveProperty("sessionName");
    expect(terminal).not.toHaveProperty("sessionName");
    // A session-bound terminal tab without a session would be pruned on reconcile;
    // it reopens as the terminal workspace, which starts a fresh session.
    expect(terminal).toEqual({ kind: "terminals", title: "Terminal", closable: true });
  });

  it("records an app whose tab was removed or whose surface was closed, but not one still open", async () => {
    const { useDesktopSurfaces } = await import("@desktop/renderer/src/stores/desktop-surfaces");
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", slug: "files", closable: false });
    const notesId = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    const editorId = useTabs.getState().openTab({ kind: "editor", title: "Editor", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId, notesId, editorId], { width: 1280, height: 800 });
    const find = (id: string) => useTabs.getState().tabs.find((candidate) => candidate.id === id)!;
    const files = find(filesId);
    const notes = find(notesId);

    recordClosedApp(find(editorId));
    expect(useClosedApps.getState().entries).toEqual([]);

    useDesktopSurfaces.getState().closeSurface(filesId);
    recordClosedApp(files);
    useTabs.getState().closeTab(notesId);
    recordClosedApp(notes);
    expect(useClosedApps.getState().entries).toEqual([
      { kind: "files", title: "Files", slug: "files", closable: false },
      { kind: "notes", title: "Notes", closable: true },
    ]);
  });
});
