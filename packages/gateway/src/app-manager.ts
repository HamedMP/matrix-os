import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAppManifest, type AppManifest } from "./app-manifest.js";
import { loadAppMeta } from "@matrix-os/kernel";

export interface AppStatus {
  slug: string;
  name: string;
  runtime: string;
  status: "running" | "stopped" | "error" | "starting";
  port?: number;
  category: string;
  description?: string;
  icon?: string;
  path: string;
}

export interface AppManager {
  register(slug: string): Promise<AppStatus>;
  stop(slug: string): Promise<void>;
  stopAll(): Promise<void>;
  get(slug: string): AppStatus | null;
  list(): AppStatus[];
  scanAndRegister(): Promise<void>;
}

export interface AppManagerConfig {
  homePath: string;
}

export function createAppManager(config: AppManagerConfig): AppManager {
  const { homePath } = config;
  const apps = new Map<string, AppStatus>();

  function appsDir(): string {
    return join(homePath, "apps");
  }

  async function register(slug: string): Promise<AppStatus> {
    const dir = join(appsDir(), slug);
    let manifest: AppManifest | null = null;

    if (existsSync(dir) && statSync(dir).isDirectory()) {
      manifest = loadAppManifest(dir);
    }

    if (!manifest) {
      const htmlFile = join(appsDir(), `${slug}.html`);
      if (existsSync(htmlFile)) {
        const meta = loadAppMeta(appsDir(), `${slug}.html`);
        manifest = {
          name: meta.name,
          description: meta.description,
          category: meta.category,
          icon: meta.icon,
          runtime: "static" as const,
          permissions: [],
          autoStart: false,
        };
      }
    }

    if (!manifest) {
      throw new Error(`No manifest found for app "${slug}"`);
    }

    const isDir = existsSync(dir) && statSync(dir).isDirectory();
    const path = isDir ? `/files/apps/${slug}/index.html` : `/files/apps/${slug}.html`;

    const status: AppStatus = {
      slug,
      name: manifest.name,
      runtime: manifest.runtime,
      status: manifest.runtime === "static" ? "running" : "stopped",
      port: manifest.port,
      category: manifest.category,
      description: manifest.description,
      icon: manifest.icon,
      path,
    };

    apps.set(slug, status);
    return status;
  }

  async function stop(slug: string): Promise<void> {
    const status = apps.get(slug);
    if (!status) return;
    status.status = "stopped";
  }

  async function stopAll(): Promise<void> {
    for (const [slug] of apps) {
      await stop(slug);
    }
  }

  function get(slug: string): AppStatus | null {
    return apps.get(slug) ?? null;
  }

  function list(): AppStatus[] {
    return Array.from(apps.values());
  }

  async function scanAndRegister(): Promise<void> {
    const dir = appsDir();
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        try {
          await register(entry);
        } catch (err: unknown) {
          console.warn("[app-manager] Could not register directory app:", err instanceof Error ? err.message : String(err));
        }
      } else if (entry.endsWith(".html")) {
        const slug = entry.replace(/\.html$/, "");
        try {
          await register(slug);
        } catch (err: unknown) {
          console.warn("[app-manager] Could not register HTML app:", err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  return { register, stop, stopAll, get, list, scanAndRegister };
}
