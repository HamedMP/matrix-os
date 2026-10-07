import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildMatrixAgentOrientation } from "../../packages/contracts/matrix-agent-orientation.mjs";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const capabilityPath = "skills/matrix/app-builder/references/matrix-capabilities.md";
const designPath = "skills/matrix/app-builder/references/distinctive-apps.md";

describe("builder capability and design guidance delivery", () => {
  it("routes the runnable email example to the explicitly selected active account", async () => {
    const prompt = read("packages/kernel/src/agents.ts");
    const example = prompt.match(/async function loadEmails\([\s\S]*?\n}\n/)?.[0];
    expect(example).toBeDefined();
    const calls: unknown[][] = [];
    const errors: string[] = [];
    const context = createContext({
      window: { MatrixOS: {
        integrations: async () => [
          { service: "gmail", status: "active", account_label: "personal" },
          { service: "gmail", status: "active", account_label: "work" },
          { service: "gmail", status: "inactive", account_label: "old" },
          { service: "gmail", status: "active", account_label: "duplicate" },
          { service: "gmail", status: "active", account_label: "duplicate" },
        ],
        service: async (...args: unknown[]) => { calls.push(args); return { data: {} }; },
      } },
      showError: (message: string) => errors.push(message),
    });
    new Script(example!).runInContext(context);
    await context.loadEmails("work");
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toBe("work");
    await context.loadEmails("old");
    await context.loadEmails(undefined);
    await context.loadEmails("duplicate");
    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(3);
    for (const path of ["home/CLAUDE.md", "home/agents/knowledge/app-generation.md"]) {
      const guidance = read(path);
      expect(guidance, path).toContain("s.account_label === selectedAccountLabel");
      expect(guidance, path).toContain("matches.length !== 1");
      expect(guidance, path).toContain("{ maxResults: 20 }, gmail.account_label");
    }
  });

  it("ships capability guidance to both skill and legacy knowledge readers", () => {
    const guide = read(capabilityPath);
    expect(read("home/agents/knowledge/matrix-app-capabilities.md")).toBe(guide);
    expect(read("skills/matrix/app-builder/SKILL.md")).toContain("references/matrix-capabilities.md");
    for (const path of ["home/agents/custom/builder.md", "packages/kernel/src/agents.ts", "home/agents/knowledge/app-generation.md"]) {
      expect(read(path), path).toContain("matrix-capabilities.md");
    }
  });

  it.each(["kernel", "claude", "codex", "hermes"])("delivers host scope and app identity guidance to %s", (surface) => {
    const orientation = buildMatrixAgentOrientation({ surface });
    expect(orientation).toContain("matrix-capabilities.md");
    expect(orientation).toContain("project sandbox");
    expect(orientation).toContain("distinctive-apps.md");
    expect(orientation).toContain("not a permission grant");
  });

  it("documents existing bridge methods without inventing a notification method", () => {
    const guide = read(capabilityPath);
    const bridge = read("shell/src/lib/os-bridge.ts");
    for (const method of ["integrations", "service", "generate", "openApp", "proxyFetch"]) {
      expect(guide).toContain(`MatrixOS.${method}`);
      expect(bridge).toMatch(new RegExp(`\\b${method}: function\\(`));
    }
    expect(guide).toContain("no general app notification bridge");
    expect(guide).toContain("ownerId");
    expect(guide).toContain("registration, not sending");
    expect(guide).toContain("not device delivery confirmation");
    expect(read("packages/gateway/src/integrations/bridge-routes.ts")).toContain('process.env.NODE_ENV === "production"');
    expect(guide).toContain("direct app service execution is blocked in production");
    expect(guide).toContain("kernel-mediated");
  });

  it("separates reminders, agent heartbeat, and Linux script execution", () => {
    const guide = read(capabilityPath);
    expect(guide).toContain("reminders, not script execution");
    expect(guide).toContain("agents/heartbeat.md");
    expect(guide).toContain("OnCalendar=*-*-* 03:00:00 Europe/London");
    expect(guide).toContain("systemd-analyze calendar");
    expect(read("packages/gateway/src/cron/types.ts")).not.toContain("timezone");
    expect(guide).toContain("host timezone");
    expect(guide).toContain("not a permanent worker");
  });

  it("requires observed availability and a complete artifact before an installation handoff", () => {
    const guide = read(capabilityPath);
    expect(read("packages/kernel/src/ipc-server.ts")).toContain('"install_app"');
    expect(guide).toContain("install_app");
    expect(guide).toContain("only when registered and authorized");
    expect(guide).toContain("Do not use another API, token, or shell route to bypass a denial");
    expect(guide).toContain("build, manifest, assets, worker, and verification report");
    expect(guide).toContain("MATRIX_HOME");
  });

  it("links actionable research and distinguishes app workflows from landing-page persuasion", () => {
    const guide = read(designPath);
    expect(read("skills/matrix/app-builder/SKILL.md")).toContain("references/distinctive-apps.md");
    for (const domain of ["docs.lovable.dev", "docs.replit.com", "emilkowal.ski", "linear.app", "x.com"]) {
      expect(guide).toContain(domain);
    }
    expect(guide).toContain("silhouette");
    expect(guide).toContain("Landing pages");
    expect(guide).toContain("Atlas");
    expect(guide).toContain("Folio");
    expect(guide).toContain("Reference evidence");
    expect(guide).toContain("No screenshot inspection is claimed");
  });

  it("makes Expo session renewal and owner-scoped cache verification part of the required workflow", () => {
    const guide = read("skills/matrix/app-builder/references/expo-loading-and-cache.md");
    const hostSession = read("apps/mobile/lib/queries/use-computer-apps.ts");
    expect(hostSession).toContain("gcTime: 0");
    expect(hostSession).toContain('refetchOnMount: "always"');
    expect(guide).toContain("gcTime: 0");
    expect(guide).toContain("expiring launch credential");
    expect(guide).toContain("owner + computer/runtime + app + query/filter + schema version");
    expect(guide).toContain("cold launch, warm reopen and return from background");
    expect(guide).toContain("no old-owner content flashes");
    expect(guide).toContain("do not create JSON, SQLite or localStorage persistence");
    expect(read("skills/matrix/app-builder/SKILL.md")).toContain("references/expo-loading-and-cache.md");
    expect(read("skills/matrix/app-builder/references/responsive-layout.md")).toContain("expo-loading-and-cache.md");
  });
});
