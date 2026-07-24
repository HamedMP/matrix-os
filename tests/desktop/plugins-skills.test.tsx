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
      if (path === "/api/terminal/sessions") return { name: "plugins-skills" };
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

  it("shows an honest empty state with a terminal path when no skills are installed", async () => {
    const api = makeApi({ skills: [] });
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);

    await waitFor(() => expect(screen.getByText("No skills installed yet.")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/terminal/sessions", {
        name: "plugins-skills",
        cwd: "projects",
      }),
    );
    const tabs = useTabs.getState().tabs;
    expect(tabs.some((tab) => tab.kind === "terminal" && tab.sessionName === "plugins-skills")).toBe(true);
  });

  it("shows generic copy when the terminal cannot be opened", async () => {
    const api = makeApi({ skills: [] });
    api.post = vi.fn(async () => {
      throw new AppError("server");
    });
    useConnection.setState({ api: api as never });
    render(<SkillsSection />);

    await waitFor(() => expect(screen.getByText("No skills installed yet.")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).not.toBeNull(),
    );
    expect(useTabs.getState().tabs).toHaveLength(0);
  });
});
