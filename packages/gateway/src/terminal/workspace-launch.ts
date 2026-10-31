import type { TerminalTab } from "@matrix-os/contracts";
import type { AgentLaunchSpec, AgentLaunchSandbox, SupportedAgent } from "../agent-launcher.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import { TerminalHostLaunchSchema } from "./host-descriptor.js";
/** Weak, private admission metadata: never JSON, argv, environment or persisted session state. */
const principals = new WeakMap<object, RequestPrincipal>();
export function retainWorkspaceTerminalPrincipal<T extends object>(input: T, principal?: RequestPrincipal): T {
  if (principal) principals.set(input, { ...principal });
  return input;
}
export function workspaceTerminalPrincipal(input: unknown): RequestPrincipal | undefined {
  return input !== null && typeof input === "object" ? principals.get(input) : undefined;
}
export interface PreparedWorkspaceTerminalLaunch {
  principal: RequestPrincipal; workspaceId: string; name: string; cwd: string; harness: SupportedAgent;
  launch: AgentLaunchSpec; policy: RoutineSourcePolicy;
}
export type WorkspaceTerminalLaunch = (input: PreparedWorkspaceTerminalLaunch) => Promise<TerminalTab | undefined>;
/** Undefined means only pre-dispatch nonrepresentability, never an uncertain launch failure.
 * Preserve original native args/env/sandbox; the caller may use its original ordinary path. */
export async function launchPreparedWorkspaceTerminal(options: {
  request: { kind: "shell" | "agent"; agent?: SupportedAgent; ownerId: string; mode?: string; sandboxMode?: string; sandbox?: AgentLaunchSandbox };
  principal?: RequestPrincipal; launch: AgentLaunchSpec; workspaceId: string; cwd: string; launchTerminal?: WorkspaceTerminalLaunch;
}) {
  const { request, principal, launchTerminal } = options;
  if (!launchTerminal || !principal || principal.userId !== request.ownerId || !["jwt", "platform-verified"].includes(principal.source)
    || request.kind !== "agent" || !request.agent || ["plan", "review"].includes(request.mode ?? "") || request.sandboxMode === "read_only" || request.sandbox?.mode === "read-only") return undefined;
  // Inheriting or credential-bearing launch specs cannot be serialized into public host descriptors.
  const launch = TerminalHostLaunchSchema.safeParse(options.launch);
  if (!launch.success) return undefined;
  return launchTerminal({ principal, workspaceId: options.workspaceId, name: request.agent, cwd: options.cwd, harness: request.agent, launch: launch.data,
    policy: { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "workspace-terminal-native-exact-v1" } });
}
