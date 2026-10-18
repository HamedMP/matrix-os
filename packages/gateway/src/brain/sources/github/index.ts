/**
 * Company Brain GitHub source (spec 558): the github kind handler for sources/core, its table bootstrap, and the
 * integration caller every connector shares.
 */
export { bootstrapBrainGithubDatabase } from "./database.js";
export { createBrainGithubSourceHandler, type BrainGithubSourceHandlerDeps } from "./handler.js";
export { createGithubAdapter, type BrainGithubAdapterDeps } from "./adapter.js";
export { createGithubRestClient, type BrainGithubRestClientOptions } from "./rest-client.js";
export { createGithubIntegrationClient, GITHUB_INTEGRATION_ACTIONS } from "./integration-client.js";
export { GITHUB_TOKEN_ENV, parseBrainGithubConfig } from "./config.js";
export { githubDocumentId } from "./documents.js";
export * from "./types.js";
export { createBrainIntegrationCaller, type BrainIntegrationCallerDeps } from "../integration/index.js";
