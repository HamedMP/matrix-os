import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const startTime = Date.now();

export interface SystemInfo {
  version: string;
  uptime: number;
  modules: number;
  channels: Record<string, boolean>;
  skills: number;
}

export function getSystemInfo(homePath: string): SystemInfo {
  let modules = 0;
  const modulesPath = join(homePath, "system", "modules.json");
  if (existsSync(modulesPath)) {
    try {
      const data = JSON.parse(readFileSync(modulesPath, "utf-8"));
      modules = Array.isArray(data) ? data.length : 0;
    } catch { /* ignore */ }
  }

  const channels: Record<string, boolean> = {};
  const configPath = join(homePath, "system", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.channels) {
        for (const [id, conf] of Object.entries(cfg.channels)) {
          channels[id] = (conf as { enabled?: boolean }).enabled ?? false;
        }
      }
    } catch { /* ignore */ }
  }

  let skills = 0;
  const skillsDir = join(homePath, "agents", "skills");
  if (existsSync(skillsDir)) {
    try {
      skills = readdirSync(skillsDir).filter((f) => f.endsWith(".md")).length;
    } catch { /* ignore */ }
  }

  return {
    version: "0.1.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    modules,
    channels,
    skills,
  };
}
