// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  listCanonicalSlashEntries, useProjectChatSlashSkills, useProjectSkillDraft,
} from "../../packages/ui/src/index.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

const context = (source = ".agents/skills") => ({
  skills: [{ name: "review", source }], instructions: [], mcpServers: [], incompleteSources: [],
});

it("uses only project skills plus runtime commands in a project, and keeps global skills outside it", async () => {
  const instance = createCanonicalProviderCatalogFixture().instances[0]!;
  instance.skills = [{ id: "global-review", displayName: "Review", description: "Installed", invocation: "/review" }];
  instance.commands = [{ id: "help", displayName: "Help", description: "Command", invocation: "/help" }];
  const read = vi.fn(async () => context());
  const { result, rerender } = renderHook(({ open }) => useProjectChatSlashSkills({ scope: "runtime", projectId: "alpha", read }, open), { initialProps: { open: false } });
  expect(read).not.toHaveBeenCalled();
  expect(listCanonicalSlashEntries(instance, result.current.catalog).map(entry => entry.id)).toEqual(["help"]);
  rerender({ open: true });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(read).toHaveBeenCalledWith("/api/projects/alpha/agent-context", expect.any(AbortSignal));
  expect(listCanonicalSlashEntries(instance, result.current.catalog)).toMatchObject([
    { kind: "project_skill", invocation: "/review", path: ".agents/skills/review/SKILL.md" },
    { kind: "command", invocation: "/help" },
  ]);
  expect(listCanonicalSlashEntries(instance).map(entry => entry.id)).toEqual(["global-review", "help"]);
});

it("ignores a late response from the previous project, even when both skills have the same name", async () => {
  let resolveOld!: (value: unknown) => void;
  const old = new Promise<unknown>(resolve => { resolveOld = resolve; });
  const read = vi.fn((path: string) => path.includes("/alpha/") ? old : Promise.resolve(context(".claude/skills")));
  const { result, rerender } = renderHook(({ projectId }) => useProjectChatSlashSkills({ scope: "runtime", projectId, read }, true), { initialProps: { projectId: "alpha" } });
  expect(read).toHaveBeenCalledTimes(1);
  rerender({ projectId: "beta" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { resolveOld(context()); });
  expect(result.current.catalog).toMatchObject({ skills: [{ source: ".claude/skills", name: "review" }] });
});

it("only adds explicitly selected manifests to a message in the same draft binding", () => {
  const { result, rerender } = renderHook(({ binding }) => useProjectSkillDraft(binding), { initialProps: { binding: "runtime:alpha:chat" } });
  const path = ".agents/skills/review/SKILL.md";
  act(() => { result.current.select("../beta/SKILL.md"); result.current.select(path); result.current.select(path); });
  expect(result.current.paths).toEqual([path]);
  expect(result.current.prompt("Check this")).toContain("Check this\n\nUse the project skill defined in");
  expect(result.current.prompt("Check this")).toContain(path);
  const oldPrompt = result.current.prompt;
  rerender({ binding: "runtime:beta:chat" });
  expect(result.current.paths).toEqual([]);
  expect(result.current.prompt("Check this")).toBe("Check this");
  expect(oldPrompt("Check this")).toBe("Check this");
  rerender({ binding: "runtime:alpha:chat" });
  expect(oldPrompt("Check this")).toBe("Check this");
  expect(result.current.paths).toEqual([]);
});
