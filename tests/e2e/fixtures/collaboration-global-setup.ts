import { clerkSetup } from "@clerk/testing/playwright";
import { loadCollaborationIdentities } from "./collaboration-identities.js";

export default async function collaborationGlobalSetup(): Promise<void> {
  // Fail before the Clerk test helper can create a token for any role.
  await loadCollaborationIdentities();
  await clerkSetup();
}
