import {
  parseSetupPlan,
  writeSetupPlan,
  createTask,
  claimTask,
  completeTask,
  failTask,
} from "@matrix-os/kernel";
import type { Dispatcher, BatchEntry, BatchResult } from "./dispatcher.js";
import type { ServerMessage } from "./server.js";

export interface ProvisionerConfig {
  homePath: string;
  dispatcher: Dispatcher;
  broadcast: (msg: ServerMessage) => void;
}

export function createProvisioner(config: ProvisionerConfig) {
  const { homePath, dispatcher, broadcast } = config;

  async function onSetupPlanChange() {
    const plan = parseSetupPlan(homePath);
    if (!plan || plan.status !== "pending") return;

    writeSetupPlan(homePath, { ...plan, status: "building" });

    const taskIds: string[] = [];
    for (const app of plan.apps) {
      const taskId = createTask(dispatcher.db, {
        type: "provision",
        input: { app: app.name, description: app.description },
      });
      claimTask(dispatcher.db, taskId, "provisioner");
      taskIds.push(taskId);

      broadcast({
        type: "task:created",
        task: {
          id: taskId,
          type: "provision",
          status: "in_progress",
          input: JSON.stringify({ app: app.name, description: app.description }),
        },
      });
    }

    broadcast({ type: "provision:start", appCount: plan.apps.length });

    const slug = (name: string) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    const batchEntries: BatchEntry[] = plan.apps.map((app, i) => ({
      taskId: taskIds[i],
      message: `[BUILD] Create the app "${app.name}" at ~/apps/${slug(app.name)}/. Description: ${app.description}. Build a complete, working web app with index.html.`,
      onEvent: () => {},
    }));

    const results = await dispatcher.dispatchBatch(batchEntries);

    const built: string[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const app = plan.apps[i];
      const taskId = taskIds[i];

      if (result.status === "fulfilled") {
        completeTask(dispatcher.db, taskId, { app: app.name });
        built.push(app.name);
        succeeded++;
        broadcast({ type: "task:updated", taskId, status: "completed" });
      } else {
        failTask(dispatcher.db, taskId, result.error ?? "Unknown error");
        failed++;
        broadcast({ type: "task:updated", taskId, status: "failed" });
      }
    }

    writeSetupPlan(homePath, { ...plan, status: "complete", built });

    broadcast({
      type: "provision:complete",
      total: plan.apps.length,
      succeeded,
      failed,
    });
  }

  return { onSetupPlanChange };
}
