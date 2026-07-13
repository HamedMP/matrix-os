declare const __CODING_AGENTS_DESKTOP_WORKSPACE__: boolean | undefined;

function bundledCodingAgentsDesktopWorkspace(): boolean | undefined {
  return typeof __CODING_AGENTS_DESKTOP_WORKSPACE__ === "boolean"
    ? __CODING_AGENTS_DESKTOP_WORKSPACE__
    : undefined;
}

export function resolveCodingAgentsDesktopWorkspaceFlag(
  bundledFlag: boolean | undefined = bundledCodingAgentsDesktopWorkspace(),
): boolean {
  return bundledFlag !== false;
}
