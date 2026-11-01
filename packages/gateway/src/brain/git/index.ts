/**
 * Company Brain git source adapter public surface. The planned
 * `brain_why(path)` read, routes and the scheduled sync import from here;
 * brain/index.ts does not re-export this folder, so there is no import cycle.
 */
export { syncGitSource } from "./sync.js";
export { defaultGitRunner, openGitRepository } from "./reader.js";
export { deriveWebBase, parseWebBase, resolveGitWebBase } from "./permalinks.js";
export { isIndexablePath } from "./parse.js";
export * from "./types.js";
