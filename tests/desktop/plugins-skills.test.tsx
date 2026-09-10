// @vitest-environment jsdom

// Component tests for the desktop Plugins hub Skills section. Skills are a
// REAL data path: the gateway exposes GET /api/settings/skills
// (packages/gateway/src/routes/settings.ts) returning
// [{ name, file, description?, enabled }]. The section renders that list
// read-only with the same capability-gating rules as integrations: a 404
// means the runtime predates the route ("unavailable"), transport failures
// show generic copy with a retry.
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SKILLS,
  SkillsSection,
  parseSkills,
  usePlugins,
} from "../../desktop/src/renderer/src/features/plugins";
import { AppError } from "../../desktop/src/shared/app-error";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;

const SKILLS = [
  {
    name: "code-review",
    file: ".agents/skills/code-review/SKILL.md",
    description: "Reviews pull requests",
    enabled: true,
  },
  { name: "qmd", file: ".agents/skills/qmd/SKILL.md", enabled: true },
];

interface FakeApiOptions {
  skills?: unknown;
  getError?: (path: string) => Error | null;
}

function makeApi(opts: FakeApiOptions = {}) {
  const { skills = SKILLS, getError } = opts;
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      const err = getError?.(path);
      if (err) throw err;
      if (path === "/api/settings/skills") return skills;
      throw new AppError("notFound");
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/api/terminal/workspaces/ensure") return { workspace: { id: WORKSPACE_ID } };
      if (path === `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) return { tab: { id: TAB_ID } };
      throw new AppError("notFound");
    }),
    delete: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putText: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("parseSkills", () => {
  it("returns an empty list for non-array payloads", () => {
    expect(parseSkills(null)).toEqual([]);
    expect(parseSkills({})).toEqual([]);
    expect(parseSkills("nope")).toEqual([]);
  });

  it("parses valid entries and drops records without a name", () => {
    const parsed = parseSkills([
      ...SKILLS,
      { file: ".agents/skills/orphan/SKILL.md" },
      "garbage",
      { name: "", file: "x" },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      name: "code-review",
      file: ".agents/skills/code-review/SKILL.md",
      description: "Reviews pull requests",
    });
    expect(parsed[1]).toEqual({
      name: "qmd",
      file: ".agents/skills/qmd/SKILL.md",
      description: null,
    });
  });

  it("caps the list at MAX_SKILLS", () => {
    const many = Array.from({ length: MAX_SKILLS + 25 }, (_, i) => ({
      name: `skill-${i}`,
      file: `f-${i}`,
    }));
    expect(parseSkills(many)).toHaveLength(MAX_SKILLS);
  });
});

describe("desktop plugins skills section", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    usePlugins.setState(usePlugins.getInitialState(), true);
    useTabs.setState({ tabs: [], activeTabId: null });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      api: makeApi() as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a loading state while the gateway responds", () => {
    const pending = new Promise<unknown>(() => undefined);
    useConnection.setState({
      api: { ...makeApi(), get: vi.fn(async () => pending) } as never,
    });
    render(<SkillsSection />);
    expect(screen.getByTestId("plugins-skills-loading")).not.toBeNull();
  });

  it("lists installed skills with name, description, and file", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());

    expect(screen.getByText("Reviews pull requests")).not.toBeNull();
    expect(screen.getByText(".agents/skills/code-review/SKILL.md")).not.toBeNull();
    expect(screen.getByText("qmd")).not.toBeNull();
    expect(screen.getByText(".agents/skills/qmd/SKILL.md")).not.toBeNull();
  });

  it("renders the shared Refresh recipe in the section header and reloads on click", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());

    // Same IconButton-with-label recipe as Providers: RefreshCw glyph plus
    // label in a subtle pill, top-right of the section header.
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    expect(refreshButton.querySelector("svg")).not.toBeNull();

    const getMock = api.get as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = getMock.mock.calls.length;
    fireEvent.click(refreshButton);
    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("filters installed skills with a clear, keyboard-accessible search", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());

    const search = screen.getByRole("searchbox", { name: "Search skills" });
    fireEvent.change(search, { target: { value: "qmd" } });

    expect(screen.queryByText("code-review")).toBeNull();
    expect(screen.getByText("qmd")).not.toBeNull();
    expect(screen.getByText("1 of 2 skills")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear skill search" }));
    expect(screen.getByText("code-review")).not.toBeNull();
    expect(screen.getByText("2 skills installed")).not.toBeNull();
  });

  it("renders an onboarding-style empty search result", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "nonexistent" },
    });

    expect(screen.getByText('No skills match “nonexistent”')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("code-review")).not.toBeNull();
  });

  it("shows a generic offline message with a retry that reloads", async () => {
    let failures = 0;
    const api = makeApi({
      getError: () => {
        failures += 1;
        return failures <= 1 ? new AppError("offline") : null;
      },
    });
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);

    await waitFor(() =>
      expect(screen.getByText("Can't reach Matrix OS. Check your connection.")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());
  });

  it("renders an unavailable state when the runtime does not expose the skills route", async () => {
    useConnection.setState({
      api: makeApi({ getError: () => new AppError("notFound") }) as never,
    });
    render(<SkillsSection />);

    await waitFor(() =>
      expect(screen.getByText("Skills are unavailable on this runtime.")).not.toBeNull(),
    );
  });

  it("keeps upstream skill errors out of renderer diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useConnection.setState({
      api: makeApi({ getError: () => new Error("secret-token-leak") }) as never,
    });
    render(<SkillsSection />);

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).not.toBeNull(),
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret-token-leak");
  });

  it("shows an honest empty state with a terminal path when no skills are installed", async () => {
    const api = makeApi({ skills: [] });
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);

    await waitFor(() => expect(screen.getByText("No skills installed yet.")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(api.post).not.toHaveBeenCalled();
    const tabs = useTabs.getState().tabs;
    expect(tabs.some((tab) => tab.kind === "terminals" && tab.title === "Terminal")).toBe(true);
  });

  it("opens the Terminal app without requiring a session request", async () => {
    const api = makeApi({ skills: [] });
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);

    await waitFor(() => expect(screen.getByText("No skills installed yet.")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));

    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(api.post).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "terminals", title: "Terminal" });
  });
});
