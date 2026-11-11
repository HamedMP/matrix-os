// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectAgentContextPanel } from "@matrix-os/ui";

const empty = { instructions: [], skills: [], mcpServers: [], incompleteSources: [] };
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("clears a former project and ignores its in-flight read across account changes", async () => {
  let release!: (body: unknown) => void;
  const oldResult = new Promise(resolve => { release = resolve; });
  const oldRead = vi.fn((_path: string, _signal: AbortSignal) => oldResult);
  const currentRead = vi.fn(async () => ({ ...empty, skills: [{ name: "current-only", source: ".agents/skills" }] }));
  const { rerender } = render(<ProjectAgentContextPanel scope="user-a:computer-a" projectId="project_a" read={oldRead} />);
  open();
  expect(await screen.findByText("Loading agent context…")).toBeTruthy();

  rerender(<ProjectAgentContextPanel scope="user-b:computer-b" projectId="project_a" read={currentRead} />);
  expect(screen.queryByRole("region", { name: "Agent configuration" })).toBeNull();
  expect(oldRead.mock.calls[0]?.[1].aborted).toBe(true);
  open();
  expect(await screen.findByText("current-only")).toBeTruthy();
  await act(async () => release({ ...empty, skills: [{ name: "former-only", source: ".agents/skills" }] }));
  expect(screen.queryByText("former-only")).toBeNull();

  rerender(<ProjectAgentContextPanel scope="user-b:computer-b" projectId="project_b" read={currentRead} />);
  expect(screen.queryByText("current-only")).toBeNull();
  open();
  expect(await screen.findByText("current-only")).toBeTruthy();
  expect(currentRead.mock.calls).toHaveLength(2);
});

it("keeps rejected metadata generic and lets the owner retry to a confirmed empty state", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = vi.fn<() => Promise<unknown>>()
    .mockResolvedValueOnce({ ...empty, mcpServers: [{ name: "fixture", source: ".mcp.json", token: "fixture-secret" }] })
    .mockResolvedValueOnce(empty);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} />);
  open();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Agent context could not be loaded.");
  expect(screen.queryByText(/fixture-secret/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No agent context files or declarations found in this project.")).toBeTruthy();
});

it("shows an unavailable project without falling back to global configuration", async () => {
  const read = vi.fn(async () => null);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_missing" read={read}
    onOpenFiles={vi.fn()} onOpenFile={vi.fn()} onOpenMcpSettings={vi.fn()} />);
  open();
  expect(await screen.findByText("Agent context is unavailable for this project.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Skills" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open project files" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open MCP settings" })).toBeNull();
  expect(read).toHaveBeenCalledOnce();
});

it("opens only one configuration section at a time and can collapse it", async () => {
  const read = vi.fn(async () => ({
    ...empty,
    configFiles: [],
    instructions: ["AGENTS.md"],
  }));
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} onCreateFile={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
  open();
  const skills = await screen.findByRole("button", { name: "Skills" });
  const mcp = screen.getByRole("button", { name: "MCP" });
  const config = screen.getByRole("button", { name: "Config files" });
  expect(skills.getAttribute("aria-expanded")).toBe("true");
  expect(mcp.getAttribute("aria-expanded")).toBe("false");
  expect(config.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "MCP" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  fireEvent.click(screen.getByRole("button", { name: "New skill" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), { target: { value: "release-review" } });
  fireEvent.click(mcp);
  expect(skills.getAttribute("aria-expanded")).toBe("false");
  expect(mcp.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("textbox", { name: "Skill name" })).toBeNull();
  expect(screen.getByRole("region", { name: "MCP" }).id).toBe(mcp.getAttribute("aria-controls"));

  fireEvent.click(config);
  expect(config.getAttribute("aria-expanded")).toBe("true");
  expect(mcp.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("region", { name: "Config files" })).toBeTruthy();
  fireEvent.click(config);
  expect(config.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "Config files" })).toBeNull();

  fireEvent.click(skills);
  expect(screen.getByRole("textbox", { name: "Skill name" })).toHaveProperty("value", "release-review");
  expect(read).toHaveBeenCalledOnce();
});

it("explains why the project has no starter config files to create", async () => {
  const onCreateFile = vi.fn();
  const onOpenFile = vi.fn();
  const read = vi.fn(async () => ({
    ...empty, instructions: ["AGENTS.md", "CLAUDE.md"], configFiles: [".claude/settings.json"],
  }));
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read}
    onCreateFile={onCreateFile} onOpenFile={onOpenFile} />);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Config files" }));
  const config = within(screen.getByRole("region", { name: "Config files" }));
  expect(config.getByText("The starter config files already exist. Open a file to edit it.")).toBeTruthy();
  expect(config.queryByRole("button", { name: /^Create / })).toBeNull();
  fireEvent.click(config.getByRole("button", { name: "Open AGENTS.md" }));
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("AGENTS.md");
  expect(onCreateFile).not.toHaveBeenCalled();
});

it("routes actions in each settings section to the exact declared project file", async () => {
  const read = vi.fn(async () => ({
    ...empty,
    instructions: ["AGENTS.md"],
    configFiles: [".mcp.json", ".codex/config.toml", ".claude/settings.json"],
    skills: [{ name: "review", source: ".agents/skills" }, { name: "review", source: ".claude/skills" }],
    mcpServers: [{ name: "docs", source: ".mcp.json" }],
  }));
  const onOpenFile = vi.fn();
  const onOpenFiles = vi.fn();
  const onOpenMcpSettings = vi.fn();
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read}
    onOpenFile={onOpenFile} onOpenFiles={onOpenFiles} onOpenMcpSettings={onOpenMcpSettings} />);
  open();
  const skills = within(await screen.findByRole("region", { name: "Skills" }));
  expect(onOpenFile).not.toHaveBeenCalled();
  expect(onOpenMcpSettings).not.toHaveBeenCalled();
  fireEvent.click(skills.getByRole("button", { name: "Open .agents/skills/review/SKILL.md" }));
  fireEvent.click(skills.getByRole("button", { name: "Open .claude/skills/review/SKILL.md" }));
  fireEvent.click(skills.getByRole("button", { name: "Add skill in Files" }));

  fireEvent.click(screen.getByRole("button", { name: "MCP" }));
  const mcp = within(screen.getByRole("region", { name: "MCP" }));
  expect(mcp.getByText("docs")).toBeTruthy();
  fireEvent.click(mcp.getByRole("button", { name: "Open .mcp.json" }));
  expect(mcp.getByText(/all projects on this computer/i)).toBeTruthy();
  fireEvent.click(mcp.getByRole("button", { name: "Open MCP settings" }));

  fireEvent.click(screen.getByRole("button", { name: "Config files" }));
  const config = within(screen.getByRole("region", { name: "Config files" }));
  fireEvent.click(config.getByRole("button", { name: "Open AGENTS.md" }));
  fireEvent.click(config.getByRole("button", { name: "Open .claude/settings.json" }));
  fireEvent.click(config.getByRole("button", { name: "Open project files" }));
  expect(onOpenFile.mock.calls.flat()).toEqual([
    ".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md", ".mcp.json", "AGENTS.md", ".claude/settings.json",
  ]);
  expect(onOpenFiles).toHaveBeenCalledTimes(2);
  expect(onOpenMcpSettings).toHaveBeenCalledOnce();
});

it("keeps project setup actions visible when empty and distinguishes an unreadable section", async () => {
  const read = vi.fn(async () => ({ ...empty, incompleteSources: [".mcp.json"] }));
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read}
    onOpenFile={vi.fn()} onOpenFiles={vi.fn()} />);
  open();
  const skills = within(await screen.findByRole("region", { name: "Skills" }));
  expect(skills.getByText(/\.agents\/skills\/<name>\/SKILL.md/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "MCP" }));
  const mcp = within(screen.getByRole("region", { name: "MCP" }));
  expect(mcp.getByText("Some MCP sources could not be read.")).toBeTruthy();
  expect(mcp.queryByText(/No project MCP config files found/)).toBeNull();
  expect(mcp.getByRole("button", { name: "Open MCP config in Files" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Config files" }));
  const config = within(screen.getByRole("region", { name: "Config files" }));
  expect(config.getByRole("button", { name: "Open project files" })).toBeTruthy();
});

it("creates an explicit project skill with a safe name and refreshes the project inventory", async () => {
  const read = vi.fn<() => Promise<unknown>>()
    .mockResolvedValueOnce({ ...empty, configFiles: [] })
    .mockResolvedValueOnce({ ...empty, configFiles: [], skills: [{ name: "release-review", source: ".agents/skills" }] });
  const onCreateFile = vi.fn(async () => true);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} onCreateFile={onCreateFile} />);
  open();
  const skills = within(await screen.findByRole("region", { name: "Skills" }));
  fireEvent.click(skills.getByRole("button", { name: "Add skill" }));
  fireEvent.click(skills.getByRole("button", { name: "New skill" }));
  const name = skills.getByRole("textbox", { name: "Skill name" });
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "../project-b" } });
  fireEvent.click(skills.getByRole("button", { name: "Create skill" }));
  expect((await skills.findByRole("alert")).textContent).toMatch(/lowercase letters/i);
  expect(onCreateFile).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "release-review" } });
  fireEvent.change(skills.getByRole("textbox", { name: "Description" }), { target: { value: 'Review releases: summarize #changes.' } });
  fireEvent.change(skills.getByRole("textbox", { name: "Instructions" }), { target: { value: "Inspect the changelog.\nList risky changes." } });
  fireEvent.click(skills.getByRole("button", { name: "Create skill" }));
  expect(await screen.findByText("release-review")).toBeTruthy();
  expect(onCreateFile).toHaveBeenCalledWith(".agents/skills/release-review/SKILL.md",
    '---\nname: "release-review"\ndescription: "Review releases: summarize #changes."\n---\n\nInspect the changelog.\nList risky changes.\n');
  expect(read).toHaveBeenCalledTimes(2);
});

it("uses empty MCP and instruction templates and keeps a safe error on an unsuccessful create", async () => {
  const read = vi.fn<() => Promise<unknown>>()
    .mockResolvedValueOnce({ ...empty, configFiles: [] })
    .mockResolvedValueOnce({ ...empty, configFiles: [".mcp.json"] });
  const onCreateFile = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} onCreateFile={onCreateFile} />);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
  const mcp = within(screen.getByRole("region", { name: "MCP" }));
  fireEvent.click(mcp.getByRole("button", { name: "Create .mcp.json" }));
  expect(await screen.findByText("No server declarations found.")).toBeTruthy();
  expect(onCreateFile).toHaveBeenCalledWith(".mcp.json", '{"mcpServers":{}}\n');
  expect(screen.queryByRole("button", { name: "Create .mcp.json" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Config files" }));
  fireEvent.click(screen.getByRole("button", { name: "Create AGENTS.md" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not be created/i);
  expect(onCreateFile).toHaveBeenCalledWith("AGENTS.md", "# Project instructions\n");
  expect(read).toHaveBeenCalledTimes(2);
});

it("uses the Files fallback when an older gateway only supplies metadata", async () => {
  const read = vi.fn(async () => empty);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read}
    onCreateFile={vi.fn()} onOpenFiles={vi.fn()} />);
  open();
  expect(await screen.findByRole("button", { name: "Add skill in Files" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add skill", exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "MCP" }));
  expect(screen.queryByRole("button", { name: "Create .mcp.json" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Config files" }));
  expect(screen.queryByRole("button", { name: "Create AGENTS.md" })).toBeNull();
});

it.each([
  ["MCP", ".codex/config.toml", "[mcp_servers]\n"],
  ["Config files", ".claude/settings.json", "{}\n"],
])("offers an inert starter in %s for %s", async (section, path, contents) => {
  const read = vi.fn(async () => ({ ...empty, configFiles: [] }));
  const onCreateFile = vi.fn(async () => true);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} onCreateFile={onCreateFile} />);
  open();
  fireEvent.click(await screen.findByRole("button", { name: section }));
  const settings = within(screen.getByRole("region", { name: section }));
  fireEvent.click(settings.getByRole("button", { name: `Create ${path}` }));
  expect(onCreateFile).toHaveBeenCalledWith(path, contents);
  expect(await screen.findByText(`Created ${path}.`)).toBeTruthy();
});

const catalog = [
  { name: "release-review", description: "Inspect changelogs", file: ".agents/skills/release-review/SKILL.md" },
  { name: "api-notes", description: "Write API notes", file: "agents/skills/api-notes.md" },
];
const skillManifest = '---\r\nname: "release-review"\r\ndescription: >-\r\n  Inspect changelogs.\r\n---\r\n\r\n# Instructions\r\n';
const readEditableContext = async () => ({ ...empty, configFiles: [] });

async function selectSkillAction(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Add skill", exact: true }));
  fireEvent.click(screen.getByRole("button", { name, exact: true }));
}

function setLocalSkillFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.change(screen.getByLabelText("SKILL.md file"), { target: { files: [file] } });
}

it("searches installed skills, reads only the selected manifest, and copies it on explicit submission", async () => {
  const loadInstalledSkills = vi.fn(async () => catalog);
  const readInstalledSkill = vi.fn(async () => skillManifest);
  const onCreateFile = vi.fn(async () => true);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={readEditableContext} onCreateFile={onCreateFile}
    loadInstalledSkills={loadInstalledSkills} readInstalledSkill={readInstalledSkill} />);
  open();
  await screen.findByRole("button", { name: "Add skill", exact: true });
  expect(loadInstalledSkills).not.toHaveBeenCalled();
  await selectSkillAction("Choose installed skill");
  expect(await screen.findByRole("radio", { name: /api-notes/ })).toBeTruthy();
  expect(screen.getByText(/Only the SKILL\.md file is copied/)).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search installed skills" }), { target: { value: "changelogs" } });
  expect(screen.queryByRole("radio", { name: /api-notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /release-review/ }));
  expect(readInstalledSkill).not.toHaveBeenCalled();
  expect(onCreateFile).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Copy to project" }));
  expect(await screen.findByText("Created .agents/skills/release-review/SKILL.md.")).toBeTruthy();
  expect(readInstalledSkill).toHaveBeenCalledExactlyOnceWith(catalog[0].file, expect.any(AbortSignal));
  expect(onCreateFile).toHaveBeenCalledExactlyOnceWith(".agents/skills/release-review/SKILL.md", skillManifest);
});

it("aborts a pending installed skill read when changing projects and never writes the previous selection", async () => {
  let release!: (content: string) => void;
  const pendingRead = new Promise<string>(resolve => { release = resolve; });
  const readInstalledSkill = vi.fn((_path: string, _signal: AbortSignal) => pendingRead);
  const onCreateFile = vi.fn(async () => true);
  const props = { scope: "owner", read: readEditableContext, onCreateFile,
    loadInstalledSkills: async () => catalog, readInstalledSkill };
  const { rerender } = render(<ProjectAgentContextPanel {...props} projectId="project_a" />);
  open();
  await selectSkillAction("Choose installed skill");
  fireEvent.click(await screen.findByRole("radio", { name: /release-review/ }));
  fireEvent.click(screen.getByRole("button", { name: "Copy to project" }));
  rerender(<ProjectAgentContextPanel {...props} projectId="project_b" />);
  expect(readInstalledSkill.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => release(skillManifest));
  expect(onCreateFile).not.toHaveBeenCalled();
  expect(screen.queryByText(/Inspect changelogs/)).toBeNull();
});

it("allows retry after a catalog error without exposing runtime details", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const loadInstalledSkills = vi.fn<() => Promise<typeof catalog>>()
    .mockRejectedValueOnce(new Error("sensitive fixture path"))
    .mockResolvedValueOnce(catalog);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={readEditableContext} onCreateFile={vi.fn()}
    loadInstalledSkills={loadInstalledSkills} readInstalledSkill={vi.fn()} />);
  open();
  await selectSkillAction("Choose installed skill");
  expect(await screen.findByText("Installed skills could not be loaded.")).toBeTruthy();
  expect(screen.queryByText(/sensitive fixture path/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading skills" }));
  expect(await screen.findByRole("radio", { name: /release-review/ })).toBeTruthy();
});

it("imports the selected manifest unchanged after rejecting invalid names, byte-order marks, and oversized files", async () => {
  const onCreateFile = vi.fn(async () => true);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={readEditableContext} onCreateFile={onCreateFile} />);
  open();
  await selectSkillAction("Import SKILL.md");
  const submit = screen.getByRole("button", { name: "Import skill" });
  expect(submit).toHaveProperty("disabled", true);

  setLocalSkillFile(skillManifest.replace("release-review", "../project-b"));
  fireEvent.click(submit);
  expect(await screen.findByText(/Use up to 64 lowercase letters or numbers/)).toBeTruthy();
  expect(onCreateFile).not.toHaveBeenCalled();

  setLocalSkillFile("\uFEFF" + skillManifest);
  fireEvent.click(submit);
  expect(await screen.findByText(/without a byte-order mark/)).toBeTruthy();
  expect(onCreateFile).not.toHaveBeenCalled();

  setLocalSkillFile(skillManifest + "a".repeat(65 * 1024));
  fireEvent.click(submit);
  expect(await screen.findByText(/must be 64 KB or smaller/)).toBeTruthy();
  expect(onCreateFile).not.toHaveBeenCalled();

  setLocalSkillFile(skillManifest);
  fireEvent.click(submit);
  expect(await screen.findByText("Created .agents/skills/release-review/SKILL.md.")).toBeTruthy();
  expect(onCreateFile).toHaveBeenCalledExactlyOnceWith(".agents/skills/release-review/SKILL.md", skillManifest);
});

it("retains the entered skill draft if the project create is rejected", async () => {
  const onCreateFile = vi.fn(async () => false);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={readEditableContext} onCreateFile={onCreateFile} />);
  open();
  await selectSkillAction("New skill");
  const name = screen.getByRole("textbox", { name: "Skill name" });
  const description = screen.getByRole("textbox", { name: "Description" });
  const instructions = screen.getByRole("textbox", { name: "Instructions" });
  fireEvent.change(name, { target: { value: "release-review" } });
  fireEvent.change(description, { target: { value: "Inspect the changelog" } });
  fireEvent.change(instructions, { target: { value: "Call out breaking changes." } });
  fireEvent.click(screen.getByRole("button", { name: "Create skill", exact: true }));
  expect(await screen.findByText(/could not be created/i)).toBeTruthy();
  expect(name).toHaveProperty("value", "release-review");
  expect(description).toHaveProperty("value", "Inspect the changelog");
  expect(instructions).toHaveProperty("value", "Call out breaking changes.");
});

it("restores the new skill draft after a failed inventory refresh and retry", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let rejectRefresh!: (error: Error) => void;
  const failedRefresh = new Promise<unknown>((_resolve, reject) => { rejectRefresh = reject; });
  const read = vi.fn<() => Promise<unknown>>()
    .mockImplementation(readEditableContext)
    .mockImplementationOnce(readEditableContext)
    .mockReturnValueOnce(failedRefresh);
  const onCreateFile = vi.fn(async () => true);
  render(<ProjectAgentContextPanel scope="owner" projectId="project_a" read={read} onCreateFile={onCreateFile} />);
  open();
  await selectSkillAction("New skill");
  fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), { target: { value: "release-review" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Inspect the changelog" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Call out breaking changes." } });

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText("Loading agent context…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create skill" })).toBeNull();
  await act(async () => rejectRefresh(new Error("Fixture read failure")));
  expect(screen.getByRole("alert").textContent).toBe("Agent context could not be loaded.");
  expect(screen.queryByRole("button", { name: "Create skill" })).toBeNull();
  expect(onCreateFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByRole("textbox", { name: "Skill name" })).toHaveProperty("value", "release-review");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveProperty("value", "Inspect the changelog");
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveProperty("value", "Call out breaking changes.");
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
  expect(await screen.findByText("Created .agents/skills/release-review/SKILL.md.")).toBeTruthy();
  await screen.findByRole("button", { name: "Add skill" });
  expect(screen.queryByRole("textbox", { name: "Skill name" })).toBeNull();
  expect(onCreateFile).toHaveBeenCalledExactlyOnceWith(".agents/skills/release-review/SKILL.md",
    '---\nname: "release-review"\ndescription: "Inspect the changelog"\n---\n\nCall out breaking changes.\n');
});

it.each([
  { scope: "owner:computer-a", projectId: "project_b" },
  { scope: "owner:computer-b", projectId: "project_a" },
])("discards the new skill draft when switching to $scope/$projectId", async next => {
  const props = { read: readEditableContext, onCreateFile: vi.fn() };
  const { rerender } = render(<ProjectAgentContextPanel {...props} scope="owner:computer-a" projectId="project_a" />);
  open();
  await selectSkillAction("New skill");
  fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), { target: { value: "private-draft" } });

  rerender(<ProjectAgentContextPanel {...props} {...next} />);
  open();
  await selectSkillAction("New skill");
  expect(screen.getByRole("textbox", { name: "Skill name" })).toHaveProperty("value", "");
  expect(props.onCreateFile).not.toHaveBeenCalled();
});
