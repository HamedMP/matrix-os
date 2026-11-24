import { createHash } from "node:crypto";
import type { ProjectSetupDraft, ProjectSetupFile } from "@matrix-os/contracts";
import { isFsError } from "../app-gallery/pinned-directory.js";
import type { ProjectSetupWorkspace } from "./project-setup-workspace.js";
import { projectSetupRootFile, projectSetupSkill, ProjectSetupError } from "./project-setup-state.js";

const hash = (content: string | null) => content === null ? null : createHash("sha256").update(content).digest("hex");

function validateProposals(draft: ProjectSetupDraft): void {
  const paths = ["AGENTS.md", "CLAUDE.md", ...(draft.skill ? [draft.skill.path] : [])];
  for (const file of draft.proposals) {
    if (!paths.includes(file.path) || (file.path.endsWith("/SKILL.md") && projectSetupSkill(file.content).path !== file.path)) throw new ProjectSetupError("invalid");
    const preserved = file.status === "already_present" || file.status === "saved";
    if (!preserved && file.path === "CLAUDE.md" && file.content !== "@AGENTS.md\n") throw new ProjectSetupError("invalid");
  }
  if (new Set(draft.proposals.map(file => file.path)).size !== draft.proposals.length) throw new ProjectSetupError("invalid");
}

export async function inspectProjectSetupFiles(workspace: ProjectSetupWorkspace, draft: ProjectSetupDraft): Promise<ProjectSetupDraft> {
  validateProposals(draft);
  const proposals: ProjectSetupFile[] = [];
  for (const file of draft.proposals) {
    await workspace.revalidate();
    const current = await workspace.read(file.path);
    if ((file.path === "AGENTS.md" || file.path === "CLAUDE.md") && (file.expectedHash === undefined || file.status === "already_present")) {
      if (current !== null) {
        proposals.push({ ...file, content: current, expectedHash: hash(current), status: "already_present" });
        continue;
      }
      if (file.status === "already_present") {
        proposals.push({ ...projectSetupRootFile(draft, file.path), expectedHash: null });
        continue;
      }
    }
    proposals.push({ ...file, expectedHash: hash(current),
      status: current === null ? "pending" : current === file.content ? "already_present" : "conflict" });
  }
  return { ...draft, proposals };
}

/** No overwrites. Each completed exclusive create survives a later-file failure. */
export async function saveProjectSetupFiles(workspace: ProjectSetupWorkspace, current: ProjectSetupDraft): Promise<ProjectSetupDraft> {
  if (current.step !== "review" || current.proposals.length < 2 || current.generation?.status === "running"
    || (current.answers.skillInstructions && !current.skill)) throw new ProjectSetupError("invalid");
  validateProposals(current);
  const draft = structuredClone(current);
  for (const file of draft.proposals) {
    try {
      await workspace.revalidate();
      const existing = await workspace.read(file.path);
      // Matching content makes an uncertain create retry safe without overwriting.
      if (existing === file.content) { file.status = "already_present"; continue; }
      if (file.expectedHash === undefined || hash(existing) !== file.expectedHash || existing !== null) { file.status = "conflict"; continue; }
      // Staging preserves bounded Markdown for review; new root files keep the Files create limit.
      if (!file.path.endsWith("/SKILL.md") && file.content.length > 8192) { file.status = "failed"; continue; }
      if (file.path === "CLAUDE.md" && !draft.proposals.some(p => p.path === "AGENTS.md" && ["saved", "already_present"].includes(p.status))) {
        file.status = "conflict";
        continue;
      }
      await workspace.create(file.path, file.content);
      file.status = "saved";
    } catch (error: unknown) {
      if (error instanceof ProjectSetupError && error.kind === "not_found") throw error;
      if (isFsError(error, "EEXIST")) file.status = "conflict";
      else {
        console.warn("[project-setup] File save failed:", error instanceof Error ? error.name : "UnknownError");
        file.status = "failed";
      }
    }
  }
  await workspace.revalidate();
  if (draft.proposals.every(file => ["saved", "already_present"].includes(file.status))) draft.step = "saved";
  return draft;
}
