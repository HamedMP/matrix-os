/**
 * Company Brain impact brief (spec 564): what a branch or base..head range changes and what the brain knows about
 * it. The service, its two routes and the pull request comment formatter; posting a comment is not done here.
 */
export { formatBrainImpactComment } from "./comment.js";
export { createBrainImpactRoutes } from "./routes.js";
export type { ImpactDependentTotals } from "./imports.js";
export { BrainImpactQuerySchema, createBrainImpactService, type BrainImpactBrief } from "./service.js";
