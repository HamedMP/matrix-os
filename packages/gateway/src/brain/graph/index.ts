/**
 * Company Brain graph public surface (spec 557): the bootstrap, the feature factory (service plus the "graph" derived
 * index) and the routes. brain/index.ts does not re-export this folder.
 */
export { bootstrapBrainGraphDatabase } from "./database.js";
export { createBrainGraph } from "./service.js";
export { createBrainGraphRoutes } from "./routes.js";
export { deriveBrainGraph } from "./derive.js";
export { brainEntityId } from "./ids.js";
export type { BrainGraphTables } from "./types.js";
