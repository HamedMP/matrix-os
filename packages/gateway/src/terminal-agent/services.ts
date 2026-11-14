import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { TerminalAgentKernelTools } from "@matrix-os/kernel";
import type { TerminalWorkspaceProjectAdmission } from "../shell/workspace-routes.js";
import { TerminalAgentVerbError } from "./verbs.js";
import { createTerminalAgents, type TerminalAgents } from "./agents.js";
import { createTerminalEventHub, type TerminalEventHub } from "./events.js";
import { createTerminalInputActivity, type TerminalInputActivity } from "./input-activity.js";
import { createTerminalAgentRegistry } from "./registry.js";
import { createTerminalAgentStatusSource, type TerminalAgentStatusSource } from "./status-source.js";
import { startTerminalAgentSupervisor } from "./supervisor.js";
import { createTerminalTemplates, type TerminalTemplates } from "./templates.js";
import { createTerminalAgentVerbs, type TerminalAgentVerbs } from "./verbs.js";
import { createTerminalWaiter, type TerminalWaiter } from "./wait.js";

export interface TerminalAgentServices {
  inputActivity: TerminalInputActivity;
  status: TerminalAgentStatusSource;
  verbs: TerminalAgentVerbs;
  waiter: TerminalWaiter;
  events: TerminalEventHub;
  templates: TerminalTemplates;
  agents: TerminalAgents;
  kernelTools: TerminalAgentKernelTools;
  close(): Promise<void>;
}

/**
 * Everything behind Herdr-style terminal agents, built once at gateway startup
 * over the terminal runtime client and shared by HTTP routes, the events socket
 * and the kernel's IPC tools.
 */
export function createTerminalAgentServices(options: {
  runtime: TerminalRuntimeSocketClient;
  homePath: string;
  /** The terminal owner; the kernel acts as this owner and only when there is exactly one. */
  terminalOwnerIds: readonly string[];
  projectAdmission: TerminalWorkspaceProjectAdmission;
}): TerminalAgentServices {
  const { runtime, homePath } = options;
  const owners = [...new Set(options.terminalOwnerIds.map((id) => id.trim()).filter(Boolean))];
  const ownerId = () => {
    if (owners.length !== 1) throw new TerminalAgentVerbError("not_found");
    return owners[0]!;
  };
  const admitWorkspace = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> =>
    options.projectAdmission.withWorkspace(ownerId(), workspaceId, "run", operation);
  const inputActivity = createTerminalInputActivity();
  const status = createTerminalAgentStatusSource({ runtime });
  const verbs = createTerminalAgentVerbs({
    runtime,
    inputActivity,
    agentStatus: async (ref) => (await status.get(ref))?.status,
    onSent: (ref) => status.noteSent?.(ref),
  });
  const waiter = createTerminalWaiter({ runtime, status });
  const events = createTerminalEventHub({ runtime, status });
  const templates = createTerminalTemplates({ homePath });
  const agents = createTerminalAgents({
    runtime,
    verbs,
    status,
    registry: createTerminalAgentRegistry({ homePath }),
    templates,
    admitWorkspace,
  });
  const supervisor = startTerminalAgentSupervisor({ agents });
  const kernelTools: TerminalAgentKernelTools = {
    async list() {
      const [workspaces, statuses] = await Promise.all([runtime.listWorkspaces(), status.list()]);
      return workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        ...(workspace.scope === "project" ? { projectId: workspace.projectId } : {}),
        tabs: workspace.tabs.filter((tab) => tab.accessScope === "owner").map((tab) => ({
          tabId: tab.id,
          name: tab.name,
          cwd: tab.cwd,
          state: tab.status === "exited" || tab.status === "failed" ? "finished" : "live",
          ...(tab.exitCode !== undefined && tab.exitCode !== null ? { exitCode: tab.exitCode } : {}),
          ...(statuses.get(`${workspace.id}:${tab.id}`) ? { agentStatus: statuses.get(`${workspace.id}:${tab.id}`)!.status } : {}),
        })),
      }));
    },
    templates: async () => (await templates.list()).map(({ name, description }) => ({ name, description })),
    // The kernel passes the same project admission as the HTTP routes.
    run: async (input) => options.projectAdmission.withProject(ownerId(), input.projectId, "run", () => agents.run({ ...input, noParent: true })),
    read: (ref, lines) => verbs.read(ref, { lines }),
    send: (ref, text) => admitWorkspace(ref.workspaceId, () => verbs.send(ref, { text })),
    keys: (ref, keys) => admitWorkspace(ref.workspaceId, () => verbs.keys(ref, { keys })),
    interrupt: (ref) => admitWorkspace(ref.workspaceId, () => verbs.interrupt(ref)),
    wait: (ref, input) => waiter.wait(ref, input),
  };
  return {
    inputActivity, status, verbs, waiter, events, templates, agents, kernelTools,
    async close() {
      // Subscribers and waiters first, so nothing touches the runtime client after it closes.
      events.shutdown();
      waiter.shutdown();
      // Ends child waits and cancels pending notes, so the supervisor's pass ends quickly.
      await agents.close();
      await supervisor.close();
    },
  };
}
