import { createMemoryEngines, type MemoryEngines } from "./engines/index.js";
import { MemoryWorkspaceRepository } from "./repository.js";
import { MemoryWorkspaceService } from "./service.js";
import { MemoryIngestionWorker } from "./ingestion-worker.js";
export { createMemoryWorkspaceRoutes } from "./routes.js";
export { MemoryWorkspaceService } from "./service.js";
export { MemoryWorkspaceRepository } from "./repository.js";
export async function createMemoryWorkspaceRuntime(options: {
  connectionString?: string;
  repository?: MemoryWorkspaceRepository;
  engines?: MemoryEngines;
  env?: NodeJS.ProcessEnv;
}) {
  if (!options.repository && !options.connectionString)
    throw new Error("Memory workspace database unavailable");
  const repository =
    options.repository ??
    MemoryWorkspaceRepository.fromConnectionString(options.connectionString!);
  try {
    await repository.bootstrap();
    const engines = options.engines ?? createMemoryEngines(options.env);
    const service = new MemoryWorkspaceService(repository, engines);
    const worker = new MemoryIngestionWorker(repository, engines);
    return {
      repository,
      service,
      worker,
      start() {
        worker.start();
      },
      async close() {
        await worker.close();
        if (!options.repository) await repository.destroy();
      },
    };
  } catch (error) {
    if (!options.repository) await repository.destroy();
    throw error;
  }
}
