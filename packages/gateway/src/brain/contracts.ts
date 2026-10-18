/**
 * Company Brain feature contracts: the one import for search, graph, sources, brief, impact, background runs, the
 * agent tools and the app (`import { ... } from "../contracts.js"`). The parts live in contracts/; feature folders never edit them.
 * Exports types and constants only, plus the BrainFeatureError class every feature throws.
 */
export * from "./contracts/common.js";
export * from "./contracts/hooks.js";
export * from "./contracts/sources.js";
export * from "./contracts/search.js";
export * from "./contracts/graph.js";
export * from "./contracts/brief.js";
export * from "./contracts/impact.js";
export * from "./contracts/agent.js";
export * from "./contracts/http.js";
export * from "./contracts/jobs.js";
