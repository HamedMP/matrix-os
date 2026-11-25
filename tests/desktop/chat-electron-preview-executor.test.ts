import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePreviewScript } from "../../desktop/src/main/chat-electron-preview/executor-capture";
import { runChatElectronPreview, verifiedSignInSource } from "../../desktop/src/main/chat-electron-preview/executor";

const sourcePath = "desktop/src/renderer/src/features/signin/SignIn.tsx";
const original = '<span className="signin-eyebrow">YOUR SPACE TO BEGIN</span>';
const updated = original.replace("YOUR SPACE TO BEGIN", "YOUR SPACE TO BUILD");
const candidateSha = createHash("sha256").update(updated).digest("hex");
const label = "YOUR SPACE TO BUILD";
const directories = new Set<string>();

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...directories].map(path => rm(path, { recursive: true, force: true })));
  directories.clear();
});

async function fixture() {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "chat-preview-test-")));
  directories.add(checkout);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const file = join(checkout, sourcePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, original);
  git("add", ".");
  git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "preview fixture");
  return { checkout, file, git, options: { checkout, electronPath: "/missing/test-electron", baseSha: git("rev-parse", "HEAD"),
    sourceSha256: candidateSha, label, signal: new AbortController().signal } };
}

describe("one-shot Electron preview source", () => {
  it("reconstructs exactly the known static label replacement", () => {
    expect(verifiedSignInSource(Buffer.from(original), label, candidateSha)).toEqual(Buffer.from(updated));
  });

  it("can reconstruct an unchanged sign-in label only for a verification request", () => {
    const baseline = Buffer.from(original);
    const baselineSha = createHash("sha256").update(baseline).digest("hex");
    expect(verifiedSignInSource(baseline, "YOUR SPACE TO BEGIN", baselineSha, true)).toEqual(baseline);
    expect(() => verifiedSignInSource(baseline, "YOUR SPACE TO BEGIN", baselineSha)).toThrow();
  });

  it.each([
    [original, 'GO</span><img onLoad={() => 1}>', candidateSha],
    [`${original}\n${original}`, label, candidateSha],
    [original, label, "a".repeat(64)],
    [original.replace("signin-eyebrow", "other"), label, candidateSha],
    [original, "YOUR SPACE TO BEGIN", candidateSha],
  ])("rejects edits outside its exact source contract", (source, requestedLabel, digest) => {
    expect(() => verifiedSignInSource(Buffer.from(source), requestedLabel, digest)).toThrow();
  });
});

describe("one-shot Electron preview execution", () => {
  it("keeps failed capture diagnostics bounded and native while returning a generic error", async () => {
    const { options, checkout } = await fixture();
    const tools = join(checkout, "failing-toolchain");
    const node = join(tools, "node"); const pnpm = join(tools, "pnpm.cjs"); const store = join(tools, "store");
    await mkdir(store, { recursive: true, mode: 0o700 }); await writeFile(pnpm, "// fixture");
    const filler = "x".repeat(12000);
    await writeFile(node, `#!/bin/sh
case "$1" in
  *vitest.mjs) printf ' Tests 5 passed (5)\\n' ;;
  --input-type=module)
    printf '${filler}\\nError: missing native verifier module\\nAuthorization: Bearer private-test-token\\napi_key=private-test-key\\n' >&2
    exit 3 ;;
esac
`);
    await chmod(node, 0o755);
    const result = await runChatElectronPreview({ ...options, requestKind: "verification", toolchain: { node, pnpm, store } })
      .then(() => null, (error: Error) => error);
    expect(result?.message).toBe("Electron preview capture failed");
    expect(result?.message).not.toContain("native verifier");
    const diagnostic = result?.cause as { stage: string; exitCode: number; stderrTail: string };
    expect(diagnostic).toMatchObject({ stage: "capture", exitCode: 3 });
    expect(diagnostic.stderrTail).toContain("missing native verifier module");
    expect(Buffer.byteLength(diagnostic.stderrTail)).toBeLessThanOrEqual(8192);
    expect(diagnostic.stderrTail).not.toContain("private-test-token");
    expect(diagnostic.stderrTail).not.toContain("private-test-key");
  });

  it("uses pinned tools and a private online cache with frozen filtered installs and no ambient credentials", async () => {
    vi.stubEnv("NODE_OPTIONS", "--unsafe-inherited-option");
    vi.stubEnv("HTTP_PROXY", "http://owner-proxy.invalid");
    vi.stubEnv("NPM_TOKEN", "private-fixture-token");
    const { options, checkout } = await fixture();
    const tools = join(checkout, "toolchain");
    const node = join(tools, "node"); const pnpm = join(tools, "pnpm.cjs"); const store = join(tools, "store");
    const audit = join(tools, "audit.log");
    const environments = join(tools, "homes.log");
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(pnpm, "// pinned fixture");
    await writeFile(node, `#!/bin/sh
printf '%s\\n' "$*" >> '${audit}'
printf '%s\\n' "$HOME|$npm_config_userconfig|$npm_config_globalconfig|$NODE_OPTIONS|$HTTP_PROXY|$NPM_TOKEN" >> '${environments}'
test -d "$HOME" || exit 7
case "$1" in
  *vitest.mjs) printf ' Tests 5 passed (5)\\n' ;;
  --input-type=module) printf '\\211PNG\\r\\n\\032\\nfixture' > "$6" ;;
esac
`);
    await chmod(node, 0o755);
    const result = await runChatElectronPreview({ ...options, requestKind: "verification", toolchain: { node, pnpm, store } });
    expect(result.testSummary).toContain("5 tests passed");
    const commands = await readFile(audit, "utf8");
    expect(commands).toContain(`${pnpm} --filter . --filter desktop... --filter @matrix-os/gateway... --filter shell... install`);
    expect(commands).toContain("--ignore-scripts --ignore-pnpmfile --frozen-lockfile");
    expect(commands).toContain("--config.registry=https://registry.npmjs.org/");
    expect(commands).toContain("--config.verify-store-integrity=true");
    expect(commands).toContain("--config.package-import-method=copy");
    expect(commands).not.toContain("--offline");
    expect(commands).toContain(`--store-dir ${store}`);
    expect(commands).toContain("node_modules/vitest/vitest.mjs run");
    expect(commands).not.toContain("corepack");
    const homes = (await readFile(environments, "utf8")).trim().split("\n");
    expect(homes).toHaveLength(5);
    expect(homes.every(home => !home.startsWith(`${homedir()}|`) && home.includes("matrix-chat-preview-") && home.endsWith("|/dev/null|/dev/null|||"))).toBe(true);
    expect(homes.slice(0, 4).every(home => home === homes[0])).toBe(true);
  });

  it("aborts a dependency fetch group and cleans the candidate while retaining its private cache", async () => {
    const { options, checkout, git } = await fixture();
    const tools = join(checkout, "abort-toolchain");
    const node = join(tools, "node"); const pnpm = join(tools, "pnpm.cjs"); const store = join(tools, "store");
    const started = join(tools, "install-started");
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(pnpm, "// fixed fixture");
    await writeFile(node, `#!/bin/sh\nprintf started > '${started}'\nsleep 30\n`);
    await chmod(node, 0o755);
    const operation = new AbortController();
    const result = runChatElectronPreview({ ...options, signal: operation.signal, requestKind: "verification", toolchain: { node, pnpm, store } })
      .then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(readFile(started, "utf8")).resolves.toBe("started"));
    operation.abort();
    expect((await result)?.message).toBe("Electron preview dependency preparation failed");
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
    expect(await realpath(store)).toBe(store);
  });

  it("rejects an unsupported interaction before opening the checkout", async () => {
    const { options } = await fixture();
    await expect(runChatElectronPreview({
      ...options, checkout: "/missing/trusted-checkout", operation: "open-external" as never,
    })).rejects.toThrow("Unsupported Electron preview interaction");
  });

  it("requires the local checkout to be at the requested trusted revision", async () => {
    const { options, git, file } = await fixture();
    await writeFile(file, `${original}\n`);
    git("add", ".");
    git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "different trusted head");

    await expect(runChatElectronPreview(options)).rejects.toThrow("trusted local revision");
    expect(await readFile(file, "utf8")).toBe(`${original}\n`);
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("rejects a tracked source symlink and cleans up the detached worktree", async () => {
    const { options, git, file } = await fixture();
    await rm(file);
    await symlink(await realpath(dirname(file)), file);
    git("add", ".");
    git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "symlink");
    await expect(runChatElectronPreview({ ...options, baseSha: git("rev-parse", "HEAD") })).rejects.toThrow("preview source");
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("does not create a temporary checkout after cancellation", async () => {
    const { options, git } = await fixture();
    await expect(runChatElectronPreview({ ...options, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });
});

describe("Electron preview capture driver", () => {
  it.each([true, false])("only captures after the UI recovers (retry enabled: %s)", async retryEnabled => {
    const checkout = await mkdtemp(join(tmpdir(), "chat-preview-driver-"));
    directories.add(checkout);
    const driver = join(checkout, "node_modules", "playwright", "index.js");
    const profile = join(checkout, "profile");
    const screenshot = join(checkout, "preview.png");
    await mkdir(dirname(driver), { recursive: true });
    await writeFile(driver, `
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
let clicked = false;
let errorObserved = false;
const signIn = {
  click: async () => { clicked = true; },
  and: selector => {
    assert.equal(selector, ":enabled");
    return { waitFor: async () => {
      assert.equal(errorObserved, true);
      assert.equal(${retryEnabled}, true, "Sign in retry is disabled");
    } };
  },
};
const page = {
  url: () => pathToFileURL(process.cwd() + "/desktop/out/renderer/index.html").href,
  getByRole: (role, options) => {
    if (role === "heading") return { waitFor: async () => {} };
    if (role === "button") {
      assert.deepEqual(options, { name: "Sign in", exact: true });
      return signIn;
    }
    assert.equal(role, "alert");
    return { filter: ({ hasText }) => ({ waitFor: async () => {
      assert.equal(clicked, true);
      assert.match("Couldn't connect. Check your connection and try again.", hasText);
      errorObserved = true;
    } }) };
  },
  locator: selector => selector === ":enabled" ? selector : { innerText: async () => ${JSON.stringify(label)} },
  evaluate: async () => {},
  screenshot: async ({ path }) => {
    assert.equal(errorObserved, true);
    await writeFile(path, "capture fixture");
  },
  waitForEvent: async () => {},
};
exports._electron = { launch: async ({ env }) => ({
  firstWindow: async () => page,
  evaluate: async () => ({ dataDirectory: env.OPERATOR_USER_DATA_DIR, visible: true }),
  process: () => ({ exitCode: 0 }),
}) };
`);
    const capture = spawnSync(process.execPath, [
      "--input-type=module", "--eval", capturePreviewScript, "/fake/electron", profile, screenshot,
      label, "verify-sign-in-recovery",
    ], { cwd: checkout, encoding: "utf8", timeout: 5_000 });
    if (retryEnabled) {
      expect(capture.stderr).toBe("");
      expect(capture.status).toBe(0);
      expect(await readFile(screenshot, "utf8")).toBe("capture fixture");
    } else {
      expect(capture.status).toBe(1);
      expect(capture.stderr).toContain("Sign in retry is disabled");
      await expect(readFile(screenshot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
