import { createFilePreviewService } from "../file-preview-service.js";
import { createCodingAgentFileAccess, createCodingAgentFileStore } from "./file-read.js";

type CodingAgentFileOptions = Parameters<typeof createCodingAgentFileStore>[0];

/** Keep file reads and previews on the same owner and project access boundary. */
export function createCodingAgentFilePreviewWiring(options: CodingAgentFileOptions) {
  const access = createCodingAgentFileAccess(options);
  return {
    codingAgentFileStore: createCodingAgentFileStore(options),
    filePreviewService: createFilePreviewService({
      homePath: options.homePath,
      canAccessHome: (principal) => access.canAccessHome(principal),
      resolveProjectRoot: (principal, resource) => access.resolveProjectRoot(principal, resource),
    }),
  };
}
