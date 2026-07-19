import type { Href } from "expo-router";
import type { MatrixAppEntry, MatrixAppManifestResponse } from "@/lib/gateway-client";
import { encodeAppSlugPath } from "@/lib/app-slugs";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

export type { MatrixAppEntry, MatrixAppManifestResponse };
export { encodeAppSlugPath };

export type NativeAppRoute =
  | "/(tabs)/chat"
  | "/(tabs)/mission-control"
  | "/(tabs)/apps"
  | "/(tabs)/workspaces"
  | "/(tabs)/settings"
  | "/canvas"
  | "/agents"
  | "/files"
  | "/terminal";

const NATIVE_ROUTE_BY_SLUG: Record<string, NativeAppRoute> = {
  chat: "/(tabs)/chat",
  terminal: "/terminal",
  tasks: "/(tabs)/mission-control",
  todo: "/(tabs)/mission-control",
  "task-manager": "/(tabs)/mission-control",
  "mission-control": "/(tabs)/mission-control",
  apps: "/(tabs)/apps",
  files: "/files",
  ...(CODING_AGENTS_MOBILE_WORKSPACE ? { agents: "/(tabs)/workspaces" as const } : {}),
  settings: "/(tabs)/settings",
  canvas: "/canvas",
  whiteboard: "/canvas",
};

const SAFE_APP_SLUG_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

const NATIVE_MATRIX_APPS: MatrixAppEntry[] = [
  {
    name: "Chat",
    description: "Talk to your Matrix OS kernel.",
    icon: "chat",
    category: "System",
    file: "chat/index.html",
    path: "/files/apps/chat/index.html",
  },
  {
    name: "Apps",
    description: "Browse and open apps in your Matrix OS.",
    icon: "grid",
    category: "System",
    slug: "apps",
    file: "apps/index.html",
    path: "/files/apps/apps/index.html",
  },
  {
    name: "Terminal",
    description: "Open a Matrix VPS shell session.",
    icon: "terminal",
    category: "System",
    slug: "terminal",
    file: "terminal/index.html",
    path: "/files/apps/terminal/index.html",
  },
  ...(CODING_AGENTS_MOBILE_WORKSPACE
    ? [
        {
          name: "Agents",
          description: "Review coding-agent work on this Matrix computer.",
          icon: "agents",
          category: "System",
          slug: "agents",
          file: "agents/index.html",
          path: "/files/apps/agents/index.html",
        },
      ]
    : []),
  {
    name: "Files",
    description: "Browse your Matrix home files and projects.",
    icon: "files",
    category: "System",
    slug: "files",
    file: "files/index.html",
    path: "/files/apps/files/index.html",
  },
  {
    name: "Canvas",
    description: "Open your workspace canvas when spatial context helps.",
    icon: "whiteboard",
    category: "System",
    slug: "canvas",
    file: "canvas/index.html",
    path: "/files/apps/canvas/index.html",
  },
  {
    name: "Tasks",
    description: "Track tasks, cron jobs, and background work.",
    icon: "task-manager",
    category: "System",
    slug: "tasks",
    file: "tasks/index.html",
    path: "/files/apps/tasks/index.html",
  },
  {
    name: "Settings",
    description: "Review your hosted Matrix OS connection and profile.",
    icon: "settings",
    category: "System",
    file: "settings/index.html",
    path: "/files/apps/settings/index.html",
  },
];

export function getAppSlug(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): string {
  const source = app.slug || app.file || app.path;
  const normalized = source ? normalizeAppSlug(source) : null;
  return normalized ?? slugifyName(app.name);
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
  if (label.includes("terminal") || label.includes("shell")) return "terminal";
  if (label.includes("chat") || label.includes("social")) return "chatbubble";
  if (label.includes("task") || label.includes("todo")) return "checkmark-circle";
  if (label.includes("note")) return "document-text";
  if (label.includes("weather")) return "partly-sunny";
  if (label.includes("clock") || label.includes("time") || label.includes("pomodoro")) return "timer";
  if (label.includes("calculator")) return "calculator";
  if (label.includes("whiteboard") || label.includes("canvas")) return "brush";
  return "apps";
}

function normalizeAppSlug(source: string): string | null {
  const withoutCacheParams = source.split(/[?#]/, 1)[0] ?? "";
  const normalizedPath = withoutCacheParams
    .replace(/\\/g, "/")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^(files\/)?apps\//i, "")
    .replace(/\/index\.html$/i, "")
    .replace(/\.html$/i, "")
    .toLowerCase();

  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => !SAFE_APP_SLUG_SEGMENT.test(part))) return null;
  return parts.join("/");
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

export function appRuntimeHref(slug: string): Href {
  return {
    pathname: "/runtime/[...slug]",
    params: { slug: slug.split("/") },
  } as unknown as Href;
}
