import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const marketplacePath = join(root, ".agents/plugins/marketplace.json");
const pluginRoot = join(root, "plugins/matrix-os");
const manifestPath = join(pluginRoot, ".codex-plugin/plugin.json");
const standaloneSkillPath = join(root, "skills/matrix-os/SKILL.md");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readSkill(name: string): string {
  return readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
}

function frontmatterName(contents: string): string | undefined {
  return contents.match(/^---\s*\n[\s\S]*?^name:\s*([^\n]+)$/m)?.[1]?.trim();
}

describe("Matrix OS Codex marketplace plugin", () => {
  it("uses the Matrix OS identifier and namespace for the single product", () => {
    const marketplace = readJson(marketplacePath) as {
      interface?: { displayName?: string };
      plugins?: Array<{ name?: string; source?: { path?: string }; category?: string }>;
    };
    const manifest = readJson(manifestPath) as {
      name?: string;
      version?: string;
      description?: string;
      interface?: {
        displayName?: string;
        shortDescription?: string;
        category?: string;
        brandColor?: string;
        defaultPrompt?: string[];
      };
    };

    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.interface?.displayName).toBe("Matrix OS");
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "matrix-os",
      source: { path: "./plugins/matrix-os" },
      category: "Productivity",
    });
    expect(dirname(dirname(manifestPath)).split("/").at(-1)).toBe("matrix-os");
    expect(manifest).toMatchObject({
      name: "matrix-os",
      version: "0.2.0",
      description: "Run development work on your Matrix cloud computer",
      interface: {
        displayName: "Matrix OS",
        shortDescription: "Run development work on your Matrix cloud computer",
        category: "Productivity",
        brandColor: "#434E3F",
      },
    });
    expect(manifest.interface?.defaultPrompt).toEqual([
      "Build a new app on my Matrix computer.",
      "Clone this GitHub repo on Matrix and make a change.",
      "Run this command on my Matrix computer.",
    ]);
  });

  it("ships self-contained composer and logo assets", () => {
    const manifest = readJson(manifestPath) as {
      interface?: { composerIcon?: string; logo?: string };
    };

    for (const assetPath of [manifest.interface?.composerIcon, manifest.interface?.logo]) {
      expect(assetPath).toMatch(/^\.\/assets\//);
      const absoluteAssetPath = resolve(pluginRoot, assetPath!);
      expect(existsSync(absoluteAssetPath)).toBe(true);
      expect(relative(realpathSync(pluginRoot), realpathSync(absoluteAssetPath))).not.toMatch(/^\.\./);
    }
  });

  it("exposes three uniquely discoverable skills", () => {
    const skillNames = ["matrix-onboarding", "matrix-cloud-run", "matrix-github-project"];
    const discoveredNames = skillNames.map((name) => frontmatterName(readSkill(name)));

    expect(discoveredNames).toEqual(skillNames);
    expect(new Set(discoveredNames).size).toBe(skillNames.length);
  });

  it("documents shared readiness and safe remote authentication", () => {
    const skills = [
      readSkill("matrix-onboarding"),
      readSkill("matrix-cloud-run"),
      readSkill("matrix-github-project"),
    ];
    const combined = skills.join("\n");

    for (const skill of skills) {
      expect(skill).toMatch(/matrix profile show cloud/);
      expect(skill).toMatch(/matrix doctor/);
      expect(skill).toMatch(/matrix whoami/);
      expect(skill).toMatch(/matrix status/);
      expect(skill).toMatch(/matrix instance info/);
    }
    expect(combined).toMatch(/codex --version/);
    expect(combined).toMatch(/codex login status/);
    expect(combined).toMatch(/claude --version/);
    expect(combined).toMatch(/claude auth status/);
    expect(readSkill("matrix-github-project")).toMatch(/gh auth status/);
    expect(combined).toMatch(/auth-codex-<suffix>/);
    expect(combined).toMatch(/auth-github-<suffix>/);
    expect(combined).toMatch(/browser\/device/i);
    expect(combined).toMatch(/Never (?:scan|read|upload)[^\n]*credential files/i);
    expect(combined).toMatch(/ask before installing/i);
  });

  it("requires observable named sessions, prohibits tabs, and sandboxes coding agents", () => {
    const skill = readSkill("matrix-cloud-run");
    const workflows = [
      readSkill("matrix-onboarding"),
      skill,
      readSkill("matrix-github-project"),
      readFileSync(standaloneSkillPath, "utf8"),
    ];

    expect(skill).toMatch(/safe relative destination/i);
    expect(skill).toMatch(/inspect[^\n]*destination/i);
    expect(skill).toMatch(/mkdir[^\n]*apps\/<slug>/);
    expect(skill).toMatch(/-C[^\n]*existing directory/i);
    for (const workflow of workflows) {
      expect(workflow).toMatch(/matrix run -it --session/);
      expect(workflow).not.toMatch(/matrix run --json/);
      expect(workflow).toMatch(/never (?:create or use|use)[^\n]*tabs/i);
      expect(workflow).toMatch(/separate[^\n]*session/i);
      expect(workflow).toMatch(/matrix shell connect/);
    }
    expect(skill).toMatch(/prompt[^\n]*argument/i);
    expect(skill).toMatch(/--sandbox workspace-write/);
    expect(skill).toMatch(/--sandbox read-only/);
    expect(skill).toMatch(/--ask-for-approval never/);
    expect(skill).toMatch(/never[^\n]*danger-full-access/i);
    expect(skill).toMatch(/claude[^\n]*--permission-mode auto/i);
    expect(skill).not.toMatch(/Claude[^\n]*supervised/i);
    expect(skill).not.toMatch(/dangerously-skip-permissions/i);
  });

  it("documents collision-safe GitHub checkout reuse and dirty-worktree preservation", () => {
    const skill = readSkill("matrix-github-project");

    expect(skill).toMatch(/projects\/<repo>/);
    expect(skill).toMatch(/apps\/<slug>/);
    expect(skill).toMatch(/gh repo clone/);
    expect(skill).toMatch(/normalized[^\n]*owner\/repository/i);
    expect(skill).toMatch(/non-Git[^\n]*collision/i);
    expect(skill).toMatch(/mismatched origin/i);
    expect(skill).toMatch(/dirty state/i);
    expect(skill).toMatch(/Never reset, clean, stash, or overwrite/i);
    expect(skill).toMatch(/remote default branch/i);
    expect(skill).toMatch(/matrix\/<task-slug>/);
    expect(skill).toMatch(/repository instructions/i);
    expect(skill).toMatch(/README/i);
    expect(skill).toMatch(/lockfiles/i);
    expect(skill).toMatch(/environment examples/i);
    expect(skill).toMatch(/push or open a PR only when explicitly requested/i);
  });

  it("keeps the standalone Matrix OS skill aligned with the umbrella workflows", () => {
    const standalone = readFileSync(standaloneSkillPath, "utf8");

    expect(standalone).toContain("# Matrix OS");
    expect(standalone).toMatch(/^author: Matrix OS$/m);
    expect(standalone).toMatch(/matrix run -it --session/);
    expect(standalone).toMatch(/gh repo clone/);
    expect(standalone).toMatch(/--sandbox workspace-write/);
    expect(standalone).toMatch(/claude[^\n]*--permission-mode auto/i);
    expect(standalone).toMatch(/Never reset, clean, stash, or overwrite/i);
    expect(standalone).not.toMatch(/dangerously-bypass-approvals-and-sandbox/);
    expect(standalone).not.toMatch(/dangerously-skip-permissions/);
    expect(standalone).not.toMatch(/upload[^\n]*credential files/i);
  });
});
