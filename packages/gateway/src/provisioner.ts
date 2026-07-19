import {
  parseSetupPlan,
  writeSetupPlan,
  createTask,
  claimTask,
  completeTask,
  failTask,
  createImageClient,
  loadIconStyle,
  buildIconPrompt,
} from "@matrix-os/kernel";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Dispatcher, BatchEntry, BatchResult } from "./dispatcher.js";
import type { ServerMessage } from "./server.js";
import { resolveExactSystemIconUrl } from "./default-icons.js";

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

    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (geminiKey && built.length > 0) {
      generateIconsForApps(homePath, geminiKey, built).catch((err) =>
        console.warn("[provisioner] Icon generation failed:", err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { onSetupPlanChange };
}

export async function generateIconsForApps(homePath: string, apiKey: string, appNames: string[]) {
  const iconStyle = loadIconStyle(homePath);
  const client = createImageClient(apiKey);
  const iconsDir = join(homePath, "system/icons");

  for (const appName of appNames) {
    const slug = appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (existsSync(join(iconsDir, `${slug}.png`)) || await resolveExactSystemIconUrl(homePath, slug)) continue;
    try {
      await client.generateImage(buildIconPrompt(slug, iconStyle), {
        aspectRatio: "1:1",
        imageDir: iconsDir,
        saveAs: `${slug}.png`,
      });
      console.log(`[provisioner] Generated icon for "${slug}"`);
    } catch (err) {
      console.warn(`[provisioner] Icon generation failed for "${slug}":`, err instanceof Error ? err.message : String(err));
    }
  }
}
