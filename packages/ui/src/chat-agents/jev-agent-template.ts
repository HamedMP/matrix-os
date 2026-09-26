import type { ChatAgentRecipe } from "@matrix-os/contracts";

export const JEV_AGENT_NAME = "Jev Inbox Triage";
export const JEV_AGENT_DESCRIPTION = "Set up a Gmail inbox review Agent. Inbox preview is not available yet.";
export function jevAgentInstructions(accountEmail: string): string {
  const email = accountEmail.trim().toLowerCase();
  if (email.length > 256 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new Error("A connected Gmail email address is required");
  }
  return `The selected Gmail account displayed ${JSON.stringify(email)} during setup; the server-owned saved account binding is authoritative. Inbox preview is not available yet. Do not call Gmail or Jev tools. Tell the user that the bounded, read-only inbox workflow is pending. Creating this Agent does not run triage or modify Gmail.`;
}

export function jevAgentRecipe(accountLabel: string): ChatAgentRecipe {
  return {
    skills: ["matrix-jev-email-triage", "matrix-integrations"],
    integrations: [{ service: "gmail", accountLabel }],
    output: "Selected Gmail account, messages examined, labels proposed or applied, archives, Review cases, and failures without full email bodies.",
  };
}
