import type { ProjectSetupDraft } from "@matrix-os/contracts";
import { applyProjectSetupInterview } from "../../../packages/gateway/src/chat/project-setup-state";

export const preservedSkillNotice = "I kept your Skill.";
export const reviewEditNotice = "You can edit the Markdown in Review.";
export const auditRequirement = "Record each release in the audit log.";
export const approvalRequirement = "Require reviewer approval.";

export function reviewWithWithheldSkill(draft: ProjectSetupDraft) {
  return applyProjectSetupInterview(draft, JSON.stringify({
    reply: "I replaced the Skill.",
    focus: "review",
    suggestions: [],
    review: { skill: { name: "approval", description: "Approve a release", instructions: approvalRequirement } },
  }), { project: { name: "Release review" }, skills: [], instructionFiles: [], mcpServices: [] }, ["skill"]);
}
