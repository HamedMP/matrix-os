/**
 * Company Brain claims: the extraction job, the rules extractor (BRAIN_RULES_EXTRACTOR_ID), model output
 * verification and the shared contract, including the model contract (model/types.ts, free of the Anthropic SDK). The
 * Claude client and its configuration (model/client.ts, model/config.ts) are imported directly. brain/index.ts does
 * not re-export this folder; the project API imports it directly.
 */
export { runBrainExtraction } from "./job.js";
export { claimSourceText, extractRulesClaims } from "./rules.js";
export { finalizeBrainClaims, verifyModelClaims } from "./verify.js";
export * from "./types.js";
export * from "./model/types.js";
