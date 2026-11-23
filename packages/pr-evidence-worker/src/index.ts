// Worker entrypoint. workerd treats every named export of the main module as
// an entrypoint, so this module exports only the default handler.
import { UploadRateLimiter } from "./bounded.js";
import { GitHubAuthorizer } from "./github.js";
import { createEvidenceWorker } from "./worker.js";

const authorizers = new Map<string, GitHubAuthorizer>();
const defaultLimiter = new UploadRateLimiter();

const defaultHandler = createEvidenceWorker({
  authorizerFor(repo) {
    let authorizer = authorizers.get(repo);
    if (!authorizer) {
      // One configured repo per deployment; cap defensively anyway.
      if (authorizers.size >= 4) authorizers.clear();
      authorizer = new GitHubAuthorizer({ repo });
      authorizers.set(repo, authorizer);
    }
    return authorizer;
  },
  limiter: defaultLimiter,
  now: Date.now,
});

const worker = {
  fetch: defaultHandler,
};

export default worker;
