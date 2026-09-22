/**
 * S07 / T038: task profile of a shared terminal.
 *
 * `sandbox_shell` is a scope-runtime terminal launched under the pinned
 * sandbox policy; a Contributor (editor role from the contributor preset)
 * may request and hold its controller. `host_shell` is the owner's own
 * terminal on the host: a stronger permission than the sandbox. Sharing a
 * host shell never grants control by itself: Contributors observe until the
 * owner records an explicit opt-in (`contributorControl: true`, set through
 * the owner-only terminal PATCH and persisted on the session), and the owner
 * may withdraw it at any time. Absent or malformed reads as withheld. A
 * sandbox capability never implies host shell control, and a Viewer observes
 * either. The profile derives from the session's sandbox binding, never from
 * prompt text.
 */
import { z } from "zod/v4";
import { SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST } from "@matrix-os/scope-runtime/sandbox";
import type { CollaborationRole } from "@matrix-os/contracts";

export const TerminalTaskProfileSchema = z.enum(["host_shell", "sandbox_shell"]);
export type TerminalTaskProfile = z.infer<typeof TerminalTaskProfileSchema>;

export const TerminalSandboxBindingSchema = z.object({
  profileId: z.literal("scope-runtime-terminal-v1"),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface TerminalTaskPolicy {
  taskProfile: TerminalTaskProfile;
  /** Owner's explicit opt-in that Contributors may control this host shell; false unless recorded. */
  contributorControl: boolean;
}

export function resolveTerminalTaskPolicy(session: {
  sandbox?: unknown;
  contributorControl?: unknown;
}): TerminalTaskPolicy {
  const sandbox = TerminalSandboxBindingSchema.safeParse(session.sandbox);
  const sandboxed = sandbox.success && sandbox.data.policyDigest === SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST;
  return {
    taskProfile: sandboxed ? "sandbox_shell" : "host_shell",
    contributorControl: session.contributorControl === true,
  };
}

export function terminalControlAllowed(input: { role: CollaborationRole; policy: TerminalTaskPolicy }): boolean {
  if (input.role === "owner") return true;
  if (input.role === "viewer") return false;
  return input.policy.taskProfile === "sandbox_shell" || input.policy.contributorControl;
}
