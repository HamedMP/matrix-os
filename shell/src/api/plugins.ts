import { queryOptions } from "@tanstack/react-query";
import { shellApi, type RequestOptions } from "./http";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  origin: string;
  status: string;
  contributions: {
    tools: number;
    hooks: number;
    channels: number;
    routes: number;
    services: number;
    skills: number;
  };
}

type PluginLoader = (options?: RequestOptions) => Promise<PluginInfo[]>;

export const pluginKeys = {
  all: () => ["plugins"] as const,
  list: () => ["plugins", "list"] as const,
};

export async function listPlugins(options?: RequestOptions): Promise<PluginInfo[]> {
  return parsePlugins(await shellApi.get<unknown>("/api/plugins", options));
}

export function pluginsQueryOptions(loader: PluginLoader = listPlugins) {
  return queryOptions({
    queryKey: pluginKeys.list(),
    queryFn: ({ signal }) => loader({ signal }),
  });
}

function parsePlugins(value: unknown): PluginInfo[] {
  if (!Array.isArray(value)) return [];
  const plugins: PluginInfo[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    const plugin = raw as Record<string, unknown>;
    if (
      typeof plugin.id !== "string"
      || typeof plugin.name !== "string"
      || typeof plugin.version !== "string"
      || typeof plugin.origin !== "string"
      || typeof plugin.status !== "string"
    ) continue;
    const contributions = plugin.contributions && typeof plugin.contributions === "object"
      ? plugin.contributions as Record<string, unknown>
      : {};
    plugins.push({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: typeof plugin.description === "string" ? plugin.description : undefined,
      origin: plugin.origin,
      status: plugin.status,
      contributions: {
        tools: count(contributions.tools),
        hooks: count(contributions.hooks),
        channels: count(contributions.channels),
        routes: count(contributions.routes),
        services: count(contributions.services),
        skills: count(contributions.skills),
      },
    });
  }
  return plugins;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0;
}
