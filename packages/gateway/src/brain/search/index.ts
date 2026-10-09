/**
 * Company Brain search (spec 556): the bootstrap, the service plus derived index, the routes, the vector stores and
 * the OpenAI embeddings provider built from the owner's settings.
 */
export { bootstrapBrainSearchDatabase } from "./database.js";
export { createBrainSearch } from "./service.js";
export { createBrainSearchRoutes } from "./routes.js";
export { createBrainPgVectorStore } from "./pgvector.js";
export { createBrainArrayVectorStore } from "./array-store.js";
export { createBrainSearchEmbeddings, type BrainEmbeddingsEnv } from "./openai-config.js";
export type { BrainSearchCapability, BrainSearchEmbeddingView, BrainSearchTables } from "./types.js";
