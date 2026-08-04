// @vitest-environment jsdom

// Plugins hub state is per-computer. Switching runtimes replaces the ApiClient
// and clears the tab strip, so anything still in flight against the previous
// computer must not land on the newly selected one.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPluginsTerminal,
  usePlugins,
} from "../../desktop/src/renderer/src/features/plugins";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

function makeApi(get: (path: string) => Promise<unknown>, post?: (path: string, body?: unknown) => Promise<unknown>) {
  return {
    baseUrl: "https://gateway.test",
    get: vi.fn(get),
    post: vi.fn(post ?? (async () => ({ name: "plugins-mcp" }))),
    delete: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putText: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("plugins hub across runtime switches", () => {
  beforeEach(() => {
    usePlugins.setState({ skills: [], skillsStatus: "idle", skillsError: null });
    useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 1, api: null });
    window.operator = { invoke: vi.fn(async () => ({})), on: vi.fn() };
  });

  it("drops a superseded computer's skills response when it settles last", async () => {
    const release: Array<() => void> = [];
    const previousApi = makeApi(async () => {
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return [{ name: "previous-owner-skill", file: "/home/other/.agents/skills/x/SKILL.md", enabled: true }];
    });
    const nextApi = makeApi(async () => [{ name: "current-skill", file: "/skills/current/SKILL.md", enabled: true }]);

    const previousRefresh = usePlugins.getState().refreshSkills(previousApi);
    await usePlugins.getState().refreshSkills(nextApi);
    expect(usePlugins.getState().skills.map((skill) => skill.name)).toEqual(["current-skill"]);

    for (const resolve of release) resolve();
    await previousRefresh;

    // The previous computer's skill names and file paths must not surface.
    expect(usePlugins.getState().skills.map((skill) => skill.name)).toEqual(["current-skill"]);
  });

  it("does not open a terminal tab for a session created on the previous computer", async () => {
    let releaseSession!: (value: { name: string }) => void;
    const api = makeApi(
      async () => [],
      () => new Promise<{ name: string }>((resolve) => { releaseSession = resolve; }),
    );
    const openTab = vi.fn();

    const opening = openPluginsTerminal(api, openTab, { sessionName: "plugins-mcp", title: "MCP servers" });
    // The user switches computers while the session POST is in flight.
    useConnection.setState({ runtimeSlot: "secondary", authGeneration: 2 });
    releaseSession({ name: "plugins-mcp" });

    await expect(opening).resolves.toBe("runtime-changed");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("drops an in-flight skills response and cached owner data on sign-out", async () => {
    let release!: (value: unknown) => void;
    const api = makeApi(
      () => new Promise<unknown>((resolve) => { release = resolve; }),
    );
    usePlugins.setState({
      skills: [{ name: "owner-only", description: "Private", file: ".agents/skills/private/SKILL.md" }],
      skillsStatus: "ready",
      skillsError: null,
    });

    const pending = usePlugins.getState().refreshSkills(api);
    await useConnection.getState().signOut();
    release([{ name: "previous-owner-skill", file: ".agents/skills/old/SKILL.md", enabled: true }]);
    await pending;

    expect(usePlugins.getState()).toMatchObject({
      skills: [],
      skillsStatus: "idle",
      skillsError: null,
    });
  });

  it("still opens the tab when the runtime is unchanged", async () => {
    const api = makeApi(async () => [], async () => ({ name: "plugins-mcp" }));
    const openTab = vi.fn();

    await expect(
      openPluginsTerminal(api, openTab, { sessionName: "plugins-mcp", title: "MCP servers" }),
    ).resolves.toBe("opened");
    expect(openTab).toHaveBeenCalledWith({ kind: "terminal", sessionName: "plugins-mcp", title: "MCP servers" });
  });
});
