import {
  FileManagementPathSchema,
  type FileEntryCapabilities,
} from "./contracts.js";
import {
  isDeniedFileApiPath,
  isProtectedHomeSubpath,
  resolveWithinHome,
} from "../path-security.js";

const MUTABLE_CAPABILITIES: FileEntryCapabilities = {
  canRename: true,
  canMove: true,
  canTrash: true,
};

const PROTECTED_CAPABILITIES: FileEntryCapabilities = {
  canRename: false,
  canMove: false,
  canTrash: false,
  readOnlyReason: "protected",
};

const POLICY_CAPABILITIES: FileEntryCapabilities = {
  canRename: false,
  canMove: false,
  canTrash: false,
  readOnlyReason: "policy",
};

export function getFileEntryCapabilities(
  homePath: string,
  requestedPath: string,
): FileEntryCapabilities {
  if (requestedPath !== "" && !FileManagementPathSchema.safeParse(requestedPath).success) {
    return { ...POLICY_CAPABILITIES };
  }
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved || isDeniedFileApiPath(homePath, requestedPath)) {
    return { ...POLICY_CAPABILITIES };
  }
  if (isProtectedHomeSubpath(homePath, resolved)) {
    return { ...PROTECTED_CAPABILITIES };
  }
  return { ...MUTABLE_CAPABILITIES };
}

export function isFileManagementMutationAllowed(homePath: string, requestedPath: string): boolean {
  const capabilities = getFileEntryCapabilities(homePath, requestedPath);
  return capabilities.canRename && capabilities.canMove && capabilities.canTrash;
}

export function isFileManagementParentAllowed(homePath: string, requestedPath: string): boolean {
  const normalizedParent = requestedPath === "." ? "" : requestedPath;
  const resolved = resolveWithinHome(homePath, normalizedParent);
  if (!resolved || isDeniedFileApiPath(homePath, normalizedParent)) return false;
  if (resolved === resolveWithinHome(homePath, "")) return true;
  return isFileManagementMutationAllowed(homePath, normalizedParent);
}
