import { defineCommand } from "citty";
import { createAuthExpiredError, createNotAuthenticatedError, resolveCliAuthStatus } from "../auth-state.js";
import { MAC_VERIFICATION_ERRORS, queueMacVerification } from "../mac-verification-client.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { MacVerificationRecipeSchema } from "@matrix-os/contracts/mac-verification-terminal";

const verifyCommand = defineCommand({
  meta: { name: "verify", description: "Queue Mac Verification for the current Git worktree and its Matrix Chat" },
  args: {
    chat: { type: "string", required: true, description: "Private Matrix worktree Chat ID" },
    worktree: { type: "string", required: true, description: "Registered Matrix worktree ID" },
    recipe: { type: "string", required: true, description: "Verification recipe: sign-in or files-trash" },
    profile: { type: "string", required: false },
    dev: { type: "boolean", default: false },
    gateway: { type: "string", required: false },
    platform: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", default: false },
  },
  async run({ args }) {
    try {
      const recipe = MacVerificationRecipeSchema.safeParse(args.recipe);
      if (!recipe.success) {
        throw Object.assign(new Error("Unknown verification recipe"), { code: "mac_verification_invalid_input" });
      }
      const profile = await resolveCliProfile(args);
      const status = await resolveCliAuthStatus(profile);
      if (status.status === "expired") throw createAuthExpiredError(profile.name, status.auth.expiresAt);
      if (status.status !== "authenticated") throw createNotAuthenticatedError(profile.name);
      const result = await queueMacVerification({
        gatewayUrl: profile.gatewayUrl, token: status.token, ownerId: status.auth?.userId,
        chatId: args.chat, worktreeId: args.worktree, recipe: recipe.data,
      });
      console.log(args.json
        ? formatCliSuccess(result)
        : `Queued Mac Verification (${result.recipe}) for ${result.chatId} run ${result.runId}. Open the originating Chat on your Mac to continue.`);
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code : "mac_verification_failed";
      const known = Object.hasOwn(MAC_VERIFICATION_ERRORS, code);
      const safeCode = known || ["auth_expired", "not_authenticated", "profile_not_found", "request_timeout", "gateway_unreachable"].includes(code)
        ? code : "mac_verification_failed";
      const message = MAC_VERIFICATION_ERRORS[safeCode as keyof typeof MAC_VERIFICATION_ERRORS]
        ?? formatCliErrorMessage(safeCode);
      console.error(args.json ? formatCliError(safeCode, message) : message);
      process.exitCode = 1;
    }
  },
});

export const macCommand = defineCommand({
  meta: { name: "mac", description: "Use your local Mac from a Matrix Chat" },
  subCommands: { verify: verifyCommand },
});
