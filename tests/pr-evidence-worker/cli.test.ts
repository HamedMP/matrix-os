import { describe, expect, it, vi } from "vitest";
import {
  buildCommentMarkdown,
  contentTypeForPath,
  main,
  parseArgs,
  resolveEndpoint,
  UsageError,
} from "../../scripts/lib/pr-evidence.mjs";
import { makeWorker, TOKEN } from "./helpers.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("pr-evidence argument parsing", () => {
  it("parses files, commit, title, and --no-comment", () => {
    expect(parseArgs(["upload", "532", "a.png", "b.mp4", "--commit", "abcdef1", "--title", "Web Desktop", "--no-comment"])).toEqual({
      help: false,
      pr: 532,
      files: ["a.png", "b.mp4"],
      commit: "abcdef1",
      title: "Web Desktop",
      comment: false,
    });
    expect(parseArgs(["upload", "7", "a.png", "--title=Canvas"]).title).toBe("Canvas");
  });

  it.each([
    [["upload"], "PR number"],
    [["upload", "abc", "a.png"], "PR number"],
    [["upload", "1"], "file"],
    [["upload", "1", "a.png", "--commit", "xyz"], "--commit"],
    [["upload", "1", "a.png", "--title"], "--title"],
    [["upload", "1", "a.png", "--bogus"], "Unknown option"],
    [["upload", "1", ...Array.from({ length: 11 }, (_, i) => `${i}.png`)], "At most"],
    [["download", "1"], "Unknown command"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("treats no command as help", () => {
    expect(parseArgs([])).toEqual({ help: true });
  });

  it("maps only allowlisted extensions", () => {
    expect(contentTypeForPath("x/Shot.PNG")).toBe("image/png");
    expect(contentTypeForPath("rec.mov")).toBe("video/quicktime");
    expect(contentTypeForPath("evil.svg")).toBeNull();
  });

  it("requires https except for localhost", () => {
    expect(resolveEndpoint({})).toBe("https://evidence.matrix-os.com");
    expect(resolveEndpoint({ MATRIX_PR_EVIDENCE_URL: "http://localhost:8787/x" })).toBe("http://localhost:8787");
    expect(() => resolveEndpoint({ MATRIX_PR_EVIDENCE_URL: "http://evil.example" })).toThrow(UsageError);
  });
});

describe("comment markdown", () => {
  it("inlines images and leaves videos as bare links on their own line", () => {
    const markdown = buildCommentMarkdown({
      title: "Web Desktop + Web Canvas",
      commit: COMMIT,
      files: [
        { name: "desk](javascript:x).png", contentType: "image/png", url: "https://evidence.matrix-os.com/pr-1/0123456/a.png" },
        { name: "flow.mp4", contentType: "video/mp4", url: "https://evidence.matrix-os.com/pr-1/0123456/b.mp4" },
      ],
    });
    expect(markdown).toContain("### PR evidence: Web Desktop + Web Canvas");
    expect(markdown).toContain("Commit: `0123456789ab`");
    expect(markdown).toContain("![desk javascript:x .png](https://evidence.matrix-os.com/pr-1/0123456/a.png)");
    expect(markdown).toMatch(/\nhttps:\/\/evidence\.matrix-os\.com\/pr-1\/0123456\/b\.mp4\n/);
  });
});

describe("pr-evidence upload against the Worker", () => {
  function setup(options: { comment?: boolean } = {}) {
    const worker = makeWorker();
    const exec = vi.fn(async (command: string, args: string[], _opts?: { input?: string }) => {
      expect(command).toBe("gh");
      if (args[0] === "auth") return { stdout: `${TOKEN}\n` };
      if (args[0] === "pr" && args[1] === "view") return { stdout: `${COMMIT}\n` };
      if (args[0] === "pr" && args[1] === "comment") return { stdout: "" };
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.byteLength));
      return worker.handle(new Request(input, { ...init, headers }), worker.env);
    });
    const files: Record<string, Uint8Array> = {
      "shots/web-desktop.png": new Uint8Array([1, 2, 3]),
      "shots/journey.webm": new Uint8Array([4, 5, 6, 7]),
    };
    const logs: string[] = [];
    const outputs: string[] = [];
    const deps = {
      exec,
      fetchImpl,
      env: {},
      readFile: async (path: string) => files[path]!,
      stat: async (path: string) => ({ isFile: () => path in files, size: files[path]?.byteLength ?? 0 }),
      log: (line: string) => logs.push(line),
      out: (text: string) => outputs.push(text),
    };
    return { worker, exec, fetchImpl, deps, logs, outputs, comment: options.comment };
  }

  it("uploads every file, defaults the commit to the PR head, and comments", async () => {
    const ctx = setup();
    const code = await main(["upload", "532", "shots/web-desktop.png", "shots/journey.webm", "--title", "Web Desktop"], ctx.deps);
    expect(code).toBe(0);
    expect(ctx.worker.bucket.objects.size).toBe(2);
    const keys = [...ctx.worker.bucket.objects.keys()];
    expect(keys.every((key) => key.startsWith("pr-532/0123456/"))).toBe(true);
    const commentCall = ctx.exec.mock.calls.find(([, args]) => args[1] === "comment")!;
    expect(commentCall[1]).toEqual(["pr", "comment", "532", "--repo", "HamedMP/matrix-os", "--body-file", "-"]);
    const viewCall = ctx.exec.mock.calls.find(([, args]) => args[1] === "view")!;
    expect(viewCall[1]).toContain("--repo");
    expect(viewCall[1][viewCall[1].indexOf("--repo") + 1]).toBe("HamedMP/matrix-os");
    const body = commentCall[2]!.input!;
    expect(body).toContain("![web-desktop.png](https://evidence.matrix-os.com/pr-532/0123456/");
    expect(body).toMatch(/\nhttps:\/\/evidence\.matrix-os\.com\/pr-532\/0123456\/[a-z2-7]{26}\.webm\n/);
  });

  it("requests each file's ticket right before uploading it so later files cannot expire", async () => {
    const ctx = setup();
    await main(["upload", "532", "shots/web-desktop.png", "shots/journey.webm"], ctx.deps);
    const sequence = ctx.fetchImpl.mock.calls.map(([, init]) => init.method);
    expect(sequence).toEqual(["POST", "PUT", "POST", "PUT"]);
  });

  it("refuses an upload URL that points away from the configured endpoint", async () => {
    const ctx = setup();
    ctx.worker.env.PUBLIC_ORIGIN = "https://elsewhere.example";
    const code = await main(["upload", "532", "shots/web-desktop.png"], ctx.deps);
    expect(code).toBe(1);
    expect(ctx.logs.join("\n")).toContain("unexpected upload URL");
  });

  it("prints markdown instead of commenting with --no-comment and honors --commit", async () => {
    const ctx = setup();
    const code = await main(["upload", "532", "shots/web-desktop.png", "--commit", "fedcba9", "--no-comment"], ctx.deps);
    expect(code).toBe(0);
    expect(ctx.exec.mock.calls.some(([, args]) => args[1] === "view" || args[1] === "comment")).toBe(false);
    expect(ctx.outputs.join("")).toContain("pr-532/fedcba9/");
  });

  it("never prints the GitHub token and reports coarse server refusals", async () => {
    const ctx = setup();
    ctx.worker.env.GITHUB_REPO = "HamedMP/matrix-os";
    ctx.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "auth") return { stdout: "gho_" + "b".repeat(36) };
      return { stdout: COMMIT };
    });
    const code = await main(["upload", "532", "shots/web-desktop.png"], ctx.deps);
    expect(code).toBe(1);
    expect(ctx.logs.join("\n")).toContain("unauthorized");
    expect(ctx.logs.join("\n")).not.toContain("gho_");
  });

  it("rejects unsupported files before contacting GitHub", async () => {
    const ctx = setup();
    const code = await main(["upload", "532", "diagram.svg"], ctx.deps);
    expect(code).toBe(2);
    expect(ctx.exec).not.toHaveBeenCalled();
  });
});
