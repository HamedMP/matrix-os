export interface DesktopRuntimeFixture {
  agentExecution: {
    mode: "cloud";
    localAgentsAllowed: false;
  };
  capabilities: string[];
  gatewayHealth: "healthy" | "degraded" | "unreachable";
  version: number;
}

export function createDesktopRuntimeFixture(
  overrides: Partial<DesktopRuntimeFixture> = {},
): DesktopRuntimeFixture {
  return {
    agentExecution: { mode: "cloud", localAgentsAllowed: false },
    capabilities: [
      "matrixShell",
      "appLauncher",
      "cloudDevelopment",
      "linearTicketSync",
      "internalTickets",
      "symphonyRunner",
    ],
    gatewayHealth: "healthy",
    version: 1,
    ...overrides,
  };
}

export interface DesktopAppLauncherFixture {
  slug: string;
  name: string;
  builtin: boolean;
  desktopAffordance: "native-tab" | "shell-window" | "external";
}

export function createDesktopLauncherApps(): DesktopAppLauncherFixture[] {
  return [
    { slug: "__workspace__", name: "Workspace", builtin: true, desktopAffordance: "native-tab" },
    { slug: "__terminal__", name: "Terminal", builtin: true, desktopAffordance: "native-tab" },
    { slug: "symphony", name: "Symphony", builtin: true, desktopAffordance: "native-tab" },
    { slug: "__file-browser__", name: "Files", builtin: true, desktopAffordance: "native-tab" },
    { slug: "__chat__", name: "Chat", builtin: true, desktopAffordance: "shell-window" },
  ];
}
