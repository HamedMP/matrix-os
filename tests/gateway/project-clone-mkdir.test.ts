import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createProjectFolders } from "../../packages/gateway/src/project-folders.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeProjectManager(overrides: Record<string, unknown> = {}) {
  return {
    getGithubStatus: vi.fn(),
    createProject: vi.fn(async () => ({
      ok: true as const,
      status: 201,
      project: { id: "proj_1", name: "repo", slug: "repo", localPath: "/x", addedAt: "", updatedAt: "" },
    })),
    listManagedProjects: vi.fn(),
    getProject: vi.fn(),
    deleteProject: vi.fn(),
    listPullRequests: vi.fn(),
    listBranches: vi.fn(),
    listGithubRepos: vi.fn(),
    ...overrides,
  };
}

describe("project clone and mkdir routes", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-project-clone-mkdir-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("POST /api/projects/clone", () => {
    it("creates a github project with slug and branch from the request", async () => {
      const projectManager = makeProjectManager();
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects/clone", {
        url: "https://github.com/owner/repo",
        name: "my-repo",
        branch: "main",
      }));

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.project.slug).toBe("repo");
      expect(projectManager.createProject).toHaveBeenCalledWith({
        mode: "github",
        url: "https://github.com/owner/repo",
        slug: "my-repo",
        name: undefined,
        branch: "main",
        ownerScope: expect.anything(),
      });
    });

    it("allows omitting name and branch", async () => {
      const projectManager = makeProjectManager();
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects/clone", {
        url: "https://github.com/owner/repo.git",
      }));

      expect(res.status).toBe(201);
      expect(projectManager.createProject).toHaveBeenCalledWith({
        mode: "github",
        url: "https://github.com/owner/repo.git",
        slug: undefined,
        name: undefined,
        branch: undefined,
        ownerScope: expect.anything(),
      });
    });

    it.each([
      "http://github.com/owner/repo",
      "https://user:pass@github.com/owner/repo",
      "https://user@github.com/owner/repo",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "https://gitlab.com/owner/repo",
      "https://github.com.evil.com/owner/repo",
      "https://github.com/owner",
      "https://github.com/owner/repo/issues",
    ])("rejects non-https-GitHub URLs: %s", async (url) => {
      const projectManager = makeProjectManager();
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects/clone", { url }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).not.toMatch(/github|url/i);
      expect(projectManager.createProject).not.toHaveBeenCalled();
    });

    it.each(["My Repo", "UPPER", "-lead", "under_score", "has space"])(
      "rejects names that are not safe slugs: %s",
      async (name) => {
        const projectManager = makeProjectManager();
        const app = createWorkspaceRoutes({ homePath, projectManager });

        const res = await app.request(jsonRequest("/api/projects/clone", {
          url: "https://github.com/owner/repo",
          name,
        }));

        expect(res.status).toBe(400);
        expect(projectManager.createProject).not.toHaveBeenCalled();
      },
    );

    it.each(["-x", "a..b", "a b", "a@{b}", ".x", "x.", "x/", "/x", "x.lock", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"])(
      "rejects unsafe branch names: %s",
      async (branch) => {
        const projectManager = makeProjectManager();
        const app = createWorkspaceRoutes({ homePath, projectManager });

        const res = await app.request(jsonRequest("/api/projects/clone", {
          url: "https://github.com/owner/repo",
          branch,
        }));

        expect(res.status).toBe(400);
        expect(projectManager.createProject).not.toHaveBeenCalled();
      },
    );

    it.each(["main", "feature/x", "release-1.2", "dependabot/npm_and_yarn/foo-1.2.3", "v1.0.0"])(
      "accepts safe branch names: %s",
      async (branch) => {
        const projectManager = makeProjectManager();
        const app = createWorkspaceRoutes({ homePath, projectManager });

        const res = await app.request(jsonRequest("/api/projects/clone", {
          url: "https://github.com/owner/repo",
          branch,
        }));

        expect(res.status).toBe(201);
      },
    );

    it("maps manager conflicts to a generic 409", async () => {
      const projectManager = makeProjectManager({
        createProject: vi.fn(async () => ({
          ok: false as const,
          status: 409,
          error: { code: "slug_conflict", message: "Project slug already exists" },
        })),
      });
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects/clone", {
        url: "https://github.com/owner/repo",
      }));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: { code: "slug_conflict", message: "Project slug already exists" },
      });
    });

    it("maps clone failures without leaking git output", async () => {
      const projectManager = makeProjectManager({
        createProject: vi.fn(async () => ({
          ok: false as const,
          status: 502,
          error: { code: "clone_failed", message: "Repository clone failed" },
        })),
      });
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects/clone", {
        url: "https://github.com/owner/repo",
      }));

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe("clone_failed");
      expect(body.error.message).not.toMatch(/stderr|fatal|git /i);
    });

    it("applies body limits", async () => {
      const app = createWorkspaceRoutes({ homePath, projectManager: makeProjectManager() });
      const res = await app.request(jsonRequest("/api/projects/clone", {
        url: "https://github.com/owner/repo",
        padding: "x".repeat(70 * 1024),
      }));

      expect(res.status).toBe(413);
    });
  });

  describe("POST /api/projects branch passthrough", () => {
    it("passes an optional branch to the project manager", async () => {
      const projectManager = makeProjectManager();
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects", {
        mode: "github",
        url: "https://github.com/owner/repo",
        branch: "develop",
      }));

      expect(res.status).toBe(201);
      expect(projectManager.createProject).toHaveBeenCalledWith(expect.objectContaining({ branch: "develop" }));
    });

    it("rejects an unsafe branch at the boundary", async () => {
      const projectManager = makeProjectManager();
      const app = createWorkspaceRoutes({ homePath, projectManager });

      const res = await app.request(jsonRequest("/api/projects", {
        mode: "github",
        url: "https://github.com/owner/repo",
        branch: "a..b",
      }));

      expect(res.status).toBe(400);
      expect(projectManager.createProject).not.toHaveBeenCalled();
    });
  });

  describe("project manager branch support", () => {
    it("passes --branch to git clone when a branch is given", async () => {
      const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: "", stderr: "" }));
      const manager = createProjectManager({ homePath, runCommand });

      const result = await manager.createProject({
        mode: "github",
        url: "https://github.com/owner/repo",
        branch: "main",
      });

      expect(result.ok).toBe(true);
      const cloneCall = runCommand.mock.calls.find(([command, args]) => command === "git" && args[0] === "clone");
      expect(cloneCall).toBeDefined();
      const args = cloneCall![1];
      expect(args.slice(0, 3)).toEqual(["clone", "--branch", "main"]);
      expect(args).toContain("--");
    });

    it("clones without --branch when none is given", async () => {
      const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: "", stderr: "" }));
      const manager = createProjectManager({ homePath, runCommand });

      const result = await manager.createProject({ mode: "github", url: "https://github.com/owner/repo" });

      expect(result.ok).toBe(true);
      const cloneCall = runCommand.mock.calls.find(([command, args]) => command === "git" && args[0] === "clone");
      expect(cloneCall![1]).not.toContain("--branch");
    });

    it("rejects an unsafe branch before running any command", async () => {
      const runCommand = vi.fn(async (_command: string, _args: string[]) => ({ stdout: "", stderr: "" }));
      const manager = createProjectManager({ homePath, runCommand });

      const result = await manager.createProject({
        mode: "github",
        url: "https://github.com/owner/repo",
        branch: "a..b",
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: { code: "invalid_branch", message: "Branch name is invalid" },
      });
      expect(runCommand).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/projects/mkdir", () => {
    it("creates projects/<name>/repo by default", async () => {
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "fresh-app" }));

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ path: "projects/fresh-app/repo" });
      const created = await stat(join(homePath, "projects", "fresh-app", "repo"));
      expect(created.isDirectory()).toBe(true);
    });

    it("returns a generic 409 when the default target already exists and never overwrites", async () => {
      await mkdir(join(homePath, "projects", "taken"), { recursive: true });
      await writeFile(join(homePath, "projects", "taken", "config.json"), "{\"keep\":true}");
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "taken" }));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("folder_conflict");
      expect(body.error.message).not.toMatch(/projects|taken|EEXIST/i);
      await expect(readFile(join(homePath, "projects", "taken", "config.json"), "utf8")).resolves.toBe("{\"keep\":true}");
    });

    it("creates a folder under a custom parent inside the home", async () => {
      await mkdir(join(homePath, "code"), { recursive: true });
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "side-project", parent: "code" }));

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ path: "code/side-project" });
      const created = await stat(join(homePath, "code", "side-project"));
      expect(created.isDirectory()).toBe(true);
    });

    it("returns 409 for an existing custom-parent folder", async () => {
      await mkdir(join(homePath, "code", "side-project"), { recursive: true });
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "side-project", parent: "code" }));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("folder_conflict");
    });

    it("treats an explicit projects parent like the default registry layout", async () => {
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "fresh-app", parent: "projects" }));

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ path: "projects/fresh-app/repo" });
    });

    it.each(["../outside", "/etc", "code/../../escape", "projects/foo", ".", "system", ".hermes", "agents", "data/browser-profiles"])(
      "rejects invalid or protected parents: %s",
      async (parent) => {
        const app = createWorkspaceRoutes({ homePath });

        const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "new-folder", parent }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toMatch(/^invalid_(request|parent)$/);
      },
    );

    it("rejects a missing parent", async () => {
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "new-folder", parent: "no-such-dir" }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_parent");
    });

    it("rejects a parent that is a file", async () => {
      await writeFile(join(homePath, "a-file"), "x");
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "new-folder", parent: "a-file" }));

      expect(res.status).toBe(400);
    });

    it("rejects a symlinked parent", async () => {
      await mkdir(join(homePath, "real-parent"), { recursive: true });
      await symlink(join(homePath, "real-parent"), join(homePath, "linked-parent"));
      const app = createWorkspaceRoutes({ homePath });

      const res = await app.request(jsonRequest("/api/projects/mkdir", { name: "new-folder", parent: "linked-parent" }));

      expect(res.status).toBe(400);
    });

    it.each(["Bad Name", "UPPER", "-lead", "under_score", "a".repeat(64)])(
      "rejects unsafe folder names: %s",
      async (name) => {
        const app = createWorkspaceRoutes({ homePath });

        const res = await app.request(jsonRequest("/api/projects/mkdir", { name }));

        expect(res.status).toBe(400);
      },
    );

    it("applies body limits", async () => {
      const app = createWorkspaceRoutes({ homePath });
      const res = await app.request(jsonRequest("/api/projects/mkdir", {
        name: "fresh-app",
        padding: "x".repeat(70 * 1024),
      }));

      expect(res.status).toBe(413);
    });
  });

  describe("project folders service", () => {
    it("rejects invalid folder names", async () => {
      const folders = createProjectFolders({ homePath });

      const result = await folders.createFolder({ name: "Bad Name" });

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: { code: "invalid_folder_name", message: "Folder name is invalid" },
      });
    });

    it("is atomically exclusive for the default registry layout", async () => {
      const folders = createProjectFolders({ homePath });

      const first = await folders.createFolder({ name: "fresh-app" });
      const second = await folders.createFolder({ name: "fresh-app" });

      expect(first.ok).toBe(true);
      expect(second).toEqual({
        ok: false,
        status: 409,
        error: { code: "folder_conflict", message: "A folder with that name already exists" },
      });
    });
  });
});
