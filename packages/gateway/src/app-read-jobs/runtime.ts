import type { Hono, Context } from "hono";
import type { Kysely } from "kysely";
import type { AppRegistry } from "../app-db-registry.js";
import type { AppIntegrationReadService } from "../integrations/app-read-bridge.js";
import type { RuntimeAppAiService } from "../app-ai/runtime.js";
import { createAppReadJobStore } from "./store.js";
import { createAppReadJobRunner, loadAppReadJobConfig, AppReadJobError } from "./runner.js";
import { createAppReadJobRoutes, type AppReadJobRouteRunner } from "./routes.js";
import { createReadJobSummary } from "./summary.js";
import { updateAppReadJobConfig } from "./config.js";

/** Composition only: injected resources remain owned by the gateway shutdown path. */
export function createAppReadJobRuntime(options: {
  app: Hono; homePath: string; ownerIds: readonly string[];
  db: Kysely<any> | null; registry: AppRegistry | null;
  ensureAppProvisioned(app: string): Promise<void>;
  readService: AppIntegrationReadService; ai: RuntimeAppAiService;
  getPrincipal?: (context: Context) => { userId: string };
}) {
  const ownerId = options.ownerIds[0];
  const summarize = createReadJobSummary(options.ai);
  const runner = ownerId && options.db && options.registry ? createAppReadJobRunner({
    ownerId,
    store: createAppReadJobStore({
      db: options.db, ownerId,
      async registeredApp(app) {
        await options.ensureAppProvisioned(app);
        return options.registry!.get(app);
      },
    }),
    loadConfig: () => loadAppReadJobConfig(options.homePath),
    updateConfig: (app, jobId, settings) => updateAppReadJobConfig(options.homePath, app, jobId, settings),
    read: (request, signal) => options.readService.read(request, signal),
    authorize: (request, signal) => options.readService.authorize(request, signal),
    onSummary: (input, signal) => summarize({ ownerId: input.ownerId, job: input.job, snapshots: input.snapshots, signal }),
  }) : null;
  const canonical = (actor: string) => {
    if (!ownerId || !options.ownerIds.includes(actor)) throw new AppReadJobError("denied");
    return ownerId;
  };
  const admitted: AppReadJobRouteRunner | null = runner ? {
    status: (actor, app, jobId) => runner.status(canonical(actor), app, jobId),
    run: (actor, app, jobId) => runner.run(canonical(actor), app, jobId),
    configure: (actor, app, jobId, settings) => runner.configure(canonical(actor), app, jobId, settings),
    pause: (actor, app, jobId, paused) => runner.pause(canonical(actor), app, jobId, paused),
  } : null;
  options.app.route("/api/app-read-jobs", createAppReadJobRoutes({ ownerIds: options.ownerIds, runner: admitted, getPrincipal: options.getPrincipal }));
  runner?.start();
  return { async stop() { await runner?.stop(); } };
}
