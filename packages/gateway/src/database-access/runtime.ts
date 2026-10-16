import { createDatabaseAccessService } from "./service.js";
import { createDatabaseExporter } from "./export.js";
import { createDatabaseAccessRoutes } from "./routes.js";

/** Fail closed without taking unrelated owner services down on unsupported hosts. */
export function createDatabaseAccessRuntime(options:{databaseUrl?:string;ownerId?:string;key:Buffer|null}) {
  let service:ReturnType<typeof createDatabaseAccessService>|null=null;
  let exporter:ReturnType<typeof createDatabaseExporter>|null=null;
  if(options.databaseUrl && options.ownerId && options.key) {
    try {
      // Construct exporter first: URL admission cannot allocate a DB pool.
      exporter=createDatabaseExporter({databaseUrl:options.databaseUrl});
      service=createDatabaseAccessService({databaseUrl:options.databaseUrl,ownerId:options.ownerId,key:options.key});
    } catch(error:unknown) {
      console.warn("[database-access] runtime unavailable",error instanceof Error ? error.name : "UnknownError");
      exporter=null;
    }
  }
  return {
    routes:createDatabaseAccessRoutes({ownerId:options.ownerId ?? null,service,exporter}),
    async close(){await exporter?.close();await service?.close();},
  };
}
