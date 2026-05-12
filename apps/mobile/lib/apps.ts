import type { Href } from "expo-router";
import type { MatrixAppEntry, MatrixAppManifestResponse } from "@/lib/gateway-client";
import { encodeAppSlugPath } from "@/lib/app-slugs";

export type { MatrixAppEntry, MatrixAppManifestResponse };
export { encodeAppSlugPath };

export type NativeAppRoute =
  | "/(tabs)/chat"
  | "/(tabs)/mission-control"
  | "/(tabs)/apps"
  | "/(tabs)/settings";

const NATIVE_ROUTE_BY_SLUG: Record<string, NativeAppRoute> = {
  chat: "/(tabs)/chat",
  tasks: "/(tabs)/mission-control",
  todo: "/(tabs)/mission-control",
  "task-manager": "/(tabs)/mission-control",
  "mission-control": "/(tabs)/mission-control",
  apps: "/(tabs)/apps",
  settings: "/(tabs)/settings",
};

export const NATIVE_MATRIX_APPS: MatrixAppEntry[] = [
  {
    name: "Chat",
    description: "Talk to your Matrix OS kernel.",
    category: "System",
    file: "chat/index.html",
    path: "/files/apps/chat/index.html",
  },
  {
    name: "Apps",
    description: "Browse and open apps in your Matrix OS.",
    category: "System",
    file: "apps/index.html",
    path: "/files/apps/apps/index.html",
  },
  {
    name: "Tasks",
    description: "Track tasks, cron jobs, and background work.",
    category: "System",
    file: "tasks/index.html",
    path: "/files/apps/tasks/index.html",
  },
  {
    name: "Settings",
    description: "Review your hosted Matrix OS connection and profile.",
    category: "System",
    file: "settings/index.html",
    path: "/files/apps/settings/index.html",
  },
];

export function getAppSlug(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): string {
  const source = app.slug || app.file || app.path || app.name;
  return source
    .replace(/^\/?(files\/)?apps\//, "")
    .replace(/\/index\.html$/, "")
    .replace(/\.html$/, "")
    .toLowerCase();
}

export function getRuntimeSlug(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): string {
  if (app.slug) return app.slug;
  return getAppSlug(app);
}

export function slugFromParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

export function getNativeAppRoute(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): NativeAppRoute | null {
  const slug = getAppSlug(app);
  return NATIVE_ROUTE_BY_SLUG[slug] ?? NATIVE_ROUTE_BY_SLUG[app.name.toLowerCase()] ?? null;
}

export function mergeNativeAndRemoteApps(remoteApps: MatrixAppEntry[]): MatrixAppEntry[] {
  const seen = new Set<string>();
  const merged: MatrixAppEntry[] = [];
  for (const app of [...NATIVE_MATRIX_APPS, ...remoteApps]) {
    const slug = getAppSlug(app);
    if (seen.has(slug)) continue;
    seen.add(slug);
    merged.push(app);
  }
  return merged;
}

export function buildGatewayAppUrl(
  baseHttpUrl: string,
  app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug" | "launchUrl">,
): string {
  const base = baseHttpUrl.replace(/\/+$/, "");
  if (app.launchUrl) {
    return app.launchUrl.startsWith("http")
      ? app.launchUrl
      : `${base}${app.launchUrl.startsWith("/") ? "" : "/"}${app.launchUrl}`;
  }
  const runtimeSlug = getRuntimeSlug(app);
  return `${base}/apps/${encodeAppSlugPath(runtimeSlug)}/`;
}

export function getGatewayAppUrlLabel(
  baseHttpUrl: string,
  app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug" | "launchUrl">,
): string {
  const slug = getAppSlug(app);
  try {
    const pathname = new URL(buildGatewayAppUrl(baseHttpUrl, app)).pathname;
    return pathname.split("/").filter(Boolean).at(-1) ?? slug;
  } catch (err: unknown) {
    console.warn("[mobile] malformed app launch URL", err instanceof Error ? err.message : String(err));
    return slug;
  }
}

export function getAppIconName(app: Pick<MatrixAppEntry, "category" | "name">): string {
  const label = `${app.category ?? ""} ${app.name}`.toLowerCase();
  if (label.includes("game")) return "game-controller";
  if (label.includes("chat") || label.includes("social")) return "chatbubble";
  if (label.includes("task") || label.includes("todo")) return "checkmark-circle";
  if (label.includes("note")) return "document-text";
  if (label.includes("weather")) return "partly-sunny";
  if (label.includes("clock") || label.includes("time") || label.includes("pomodoro")) return "timer";
  if (label.includes("calculator")) return "calculator";
  if (label.includes("whiteboard") || label.includes("canvas")) return "brush";
  return "apps";
}

export function appDetailHref(slug: string): Href {
  return {
    pathname: "/apps/[...slug]",
    params: { slug: slug.split("/") },
  } as unknown as Href;
}

export function appRuntimeHref(slug: string): Href {
  return {
    pathname: "/runtime/[...slug]",
    params: { slug: slug.split("/") },
  } as unknown as Href;
}
