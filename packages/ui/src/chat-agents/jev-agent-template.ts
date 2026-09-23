import type { ChatAgentRecipe } from "@matrix-os/contracts";

export const JEV_AGENT_NAME = "Jev Inbox Triage";
export const JEV_AGENT_DESCRIPTION = "Classify a connected Gmail inbox with Matrix-funded Jev and review proposed labels before changing mail.";
export const JEV_AGENT_INSTRUCTIONS = "Use the Gmail account pinned in this Agent's integrations. Follow the matrix-jev-email-triage skill to classify messages with Matrix-funded Jev. Show proposed labels before changing mail. Change labels or archive only when the user explicitly authorizes those actions. Never send, reply, forward, trash, delete, or mark mail read. Creating this Agent does not run triage or modify Gmail.";

export function jevAgentRecipe(accountLabel: string): ChatAgentRecipe {
  return {
    skills: ["matrix-jev-email-triage", "matrix-integrations"],
    integrations: [{ service: "gmail", accountLabel }],
    output: "Selected Gmail account, messages examined, labels proposed or applied, archives, Review cases, and failures without full email bodies.",
  };
}
