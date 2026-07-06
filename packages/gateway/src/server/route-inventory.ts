export interface GatewayRouteGroup {
  id: string;
  label: string;
  paths: string[];
  plannedModule: string;
}

export const GATEWAY_ROUTE_GROUPS: GatewayRouteGroup[] = [
  {
    id: "middleware",
    label: "Global middleware and metrics",
    paths: ["*", "/metrics"],
    plannedModule: "server/middleware.ts",
  },
  {
    id: "readiness",
    label: "Onboarding, agent readiness, and admin controls",
    paths: [
      "/api/onboarding",
      "/api/agents",
      "/api/integrations",
      "/api/admin",
      "/api/company-brain",
      "/api/support-growth",
    ],
    plannedModule: "server/routes/readiness.ts",
  },
  {
    id: "shell-terminal",
    label: "Shell terminal HTTP and WebSocket routes",
    paths: ["/api/terminal", "/api", "/ws/terminal", "/ws/terminal/session"],
    plannedModule: "server/routes/shell-terminal.ts",
  },
  {
    id: "app-runtime",
    label: "Installed app runtime sessions and dispatch",
    paths: ["/api/apps/:slug/manifest", "/api/apps/:slug/ack", "/api/apps/:slug/session", "/api/apps/:slug/session-token", "/apps/:slug/*"],
    plannedModule: "server/app-runtime-routes.ts",
  },
  {
    id: "websockets",
    label: "Main, sync, forward, onboarding, and vocal WebSockets",
    paths: ["/ws", "/ws/forward", "/ws/onboarding", "/ws/vocal"],
    plannedModule: "server/websockets.ts",
  },
  {
    id: "files-workspace",
    label: "Files, projects, static file serving, and workspace routes",
    paths: ["/api/files", "/api/projects", "/files/*", "/"],
    plannedModule: "server/file-routes.ts",
  },
  {
    id: "bridge",
    label: "App bridge query, data, proxy, and integration service calls",
    paths: ["/api/bridge/query", "/api/bridge/proxy", "/api/bridge/data", "/api/bridge/service"],
    plannedModule: "server/routes/bridge.ts",
  },
  {
    id: "system",
    label: "System activity, update, settings, health, and Hermes routes",
    paths: ["/api/system", "/system/backup", "/api/settings", "/api/hermes", "/health"],
    plannedModule: "server/routes/system.ts",
  },
  {
    id: "data-features",
    label: "Conversations, canvas, messaging, sync, social, cron, plugins, and games",
    paths: ["/api/conversations", "/api/canvases", "/api/messages", "/api/sync", "/api/social", "/api/cron", "/api/plugins", "/api/games"],
    plannedModule: "server/routes/data-features.ts",
  },
];

export function gatewayRouteGroupForPath(path: string): GatewayRouteGroup | undefined {
  const matches = GATEWAY_ROUTE_GROUPS.flatMap((group) =>
    group.paths
      .filter((pattern) => routePatternMatches(pattern, path))
      .map((pattern) => ({ group, pattern })),
  );
  matches.sort((a, b) => routePatternSpecificity(b.pattern) - routePatternSpecificity(a.pattern));
  return matches[0]?.group;
}

function routePatternMatches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === path) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  if (pattern.includes(":")) {
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) return false;
    return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
  }
  return path.startsWith(`${pattern}/`);
}

function routePatternSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  return pattern.replaceAll(":", "").replaceAll("*", "").length;
}
