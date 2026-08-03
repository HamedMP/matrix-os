// @vitest-environment jsdom

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCanonicalTerminalLaunchCommand,
  createTerminalLaunchPath,
  consumeTerminalLaunchActionFromLocation,
  drainTerminalLaunchQueue,
  enqueueTerminalLaunch,
  enqueueTerminalLaunchAction,
  parseTerminalLaunchActionFromSearch,
  parseTerminalLaunchPath,
  TERMINAL_SETUP_WINDOW_PATH,
} from "../../shell/src/lib/terminal-launch.js";

describe("terminal launch paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("maps onboarding setup actions to startup commands", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_779_788_800_000);

    expect(parseTerminalLaunchPath(createTerminalLaunchPath("claude-login"))).toMatchObject({
      label: "Claude login",
      command: "claude",
      claudeMode: true,
    });
    expect(parseTerminalLaunchPath(createTerminalLaunchPath("codex-login"))).toMatchObject({
      label: "Codex login",
      command: "codex",
    });
    const githubLogin = parseTerminalLaunchPath(createTerminalLaunchPath("github-ssh-login"));
    expect(githubLogin?.label).toBe("GitHub browser login");
    expect(githubLogin?.command).toContain("gh auth login --hostname github.com --web");
    expect(githubLogin?.command).toContain("Matrix-managed key");
    expect(githubLogin?.command).not.toContain("--git-protocol ssh");
  });

  it("ignores ordinary terminal paths", () => {
    expect(parseTerminalLaunchPath("__terminal__")).toBeNull();
    expect(parseTerminalLaunchPath("__terminal__:random")).toBeNull();
  });

  it("targets setup actions at the canonical terminal surface", () => {
    expect(TERMINAL_SETUP_WINDOW_PATH).toBe("__terminal__");
  });

  it("maps the fixed T3 Connect handoff to a visible owner-scoped setup command", () => {
    const config = parseTerminalLaunchActionFromSearch(
      "?launch=__terminal__&terminal_action=t3-connect",
    );

    expect(config).toMatchObject({
      action: "t3-connect",
      label: "Set up T3 Code",
    });
    expect(config?.command).toContain('MATRIX_T3_HOME="${MATRIX_HOME:-$HOME}/system/t3code"');
    expect(config?.command).toContain("read -r MATRIX_T3_CONFIRM");
    expect(config?.command).toContain('MATRIX_T3_PUBLIC_BASE_URL="https://app.matrix-os.com/vm/$MATRIX_HANDLE/api/integrations/t3/"');
    expect(config?.command).toContain("npx --yes t3@0.0.32 pair");
    expect(config?.command).toContain("npx --yes t3@0.0.32 serve");
    expect(config?.command).toContain("--host 127.0.0.1 --port 3773");
    expect(config?.command).toContain('--pairing-base-url "$MATRIX_T3_PUBLIC_BASE_URL"');
    expect(config?.command).not.toContain("connect link");
    expect(config?.command).not.toContain("--headless");
    expect(config?.command).not.toContain("t3@latest");
    expect(config?.command.indexOf("read -r MATRIX_T3_CONFIRM")).toBeLessThan(
      config?.command.indexOf("npx --yes t3@0.0.32") ?? -1,
    );
    expect(config?.command).toContain('--base-dir "$MATRIX_T3_HOME"');
  });

  it("consumes the fixed handoff query after it has been queued", () => {
    window.history.replaceState(
      {},
      "",
      "/?launch=__terminal__&terminal_action=t3-connect&kept=1#section",
    );

    expect(consumeTerminalLaunchActionFromLocation()).toBe(true);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/?kept=1#section",
    );
    expect(consumeTerminalLaunchActionFromLocation()).toBe(false);
  });

  it("does not invoke the pinned T3 package until the user confirms", () => {
    const config = parseTerminalLaunchActionFromSearch(
      "?launch=__terminal__&terminal_action=t3-connect",
    );
    const root = mkdtempSync(join(tmpdir(), "matrix-t3-connect-"));
    const prefix = join(root, "node");
    const bin = join(prefix, "bin");
    const marker = join(root, "invoked");
    const fakeNpx = join(bin, "npx");
    const canonicalCommand = createCanonicalTerminalLaunchCommand(config?.command ?? "");
    try {
      mkdirSync(bin, { recursive: true });
      writeFileSync(fakeNpx, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MATRIX_T3_TEST_MARKER"\n');
      chmodSync(fakeNpx, 0o755);
      const env = {
        ...process.env,
        MATRIX_HOME: root,
        MATRIX_HANDLE: "test-handle",
        MATRIX_NODE_PREFIX: prefix,
        MATRIX_T3_TEST_MARKER: marker,
      };

      const declined = spawnSync("sh", ["-c", canonicalCommand], {
        encoding: "utf8",
        env,
        input: "n\n",
      });
      expect(declined.status).toBe(0);
      expect(existsSync(marker)).toBe(false);

      const approved = spawnSync("sh", ["-c", canonicalCommand], {
        encoding: "utf8",
        env,
        input: "y\n",
      });
      expect(approved.status).toBe(0);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([
        `--yes t3@0.0.32 pair --pairing-base-url https://app.matrix-os.com/vm/test-handle/api/integrations/t3/ --base-dir ${join(root, "system/t3code")}`,
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("starts the loopback server when no existing T3 process can mint a pairing link", () => {
    const config = parseTerminalLaunchActionFromSearch(
      "?launch=__terminal__&terminal_action=t3-connect",
    );
    const root = mkdtempSync(join(tmpdir(), "matrix-t3-serve-"));
    const prefix = join(root, "node");
    const bin = join(prefix, "bin");
    const marker = join(root, "invoked");
    const fakeNpx = join(bin, "npx");
    const canonicalCommand = createCanonicalTerminalLaunchCommand(config?.command ?? "");
    try {
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        fakeNpx,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MATRIX_T3_TEST_MARKER"\ncase "$*" in *"t3@0.0.32 pair"*) exit 1 ;; esac\n',
      );
      chmodSync(fakeNpx, 0o755);

      const result = spawnSync("sh", ["-c", canonicalCommand], {
        encoding: "utf8",
        env: {
          ...process.env,
          MATRIX_HOME: root,
          MATRIX_HANDLE: "test-handle",
          MATRIX_NODE_PREFIX: prefix,
          MATRIX_T3_TEST_MARKER: marker,
        },
        input: "y\n",
      });

      expect(result.status).toBe(0);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([
        `--yes t3@0.0.32 pair --pairing-base-url https://app.matrix-os.com/vm/test-handle/api/integrations/t3/ --base-dir ${join(root, "system/t3code")}`,
        `--yes t3@0.0.32 serve --host 127.0.0.1 --port 3773 --pairing-base-url https://app.matrix-os.com/vm/test-handle/api/integrations/t3/ --base-dir ${join(root, "system/t3code")}`,
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects arbitrary terminal actions and actions without the canonical Terminal launch", () => {
    expect(
      parseTerminalLaunchActionFromSearch(
        "?launch=__terminal__&terminal_action=rm-everything",
      ),
    ).toBeNull();
    expect(
      parseTerminalLaunchActionFromSearch(
        "?launch=__chat__&terminal_action=t3-connect",
      ),
    ).toBeNull();
    expect(
      parseTerminalLaunchActionFromSearch(
        "?launch=__terminal__&launch=__terminal__&terminal_action=t3-connect",
      ),
    ).toBeNull();
    expect(
      parseTerminalLaunchActionFromSearch(
        "?launch=__terminal__&terminal_action=t3-connect&terminal_action=t3-connect",
      ),
    ).toBeNull();
  });

  it("does not consume a duplicated handoff query", () => {
    window.history.replaceState(
      {},
      "",
      "/?launch=__terminal__&terminal_action=t3-connect&terminal_action=t3-connect",
    );

    expect(consumeTerminalLaunchActionFromLocation()).toBe(false);
    expect(window.location.search).toBe(
      "?launch=__terminal__&terminal_action=t3-connect&terminal_action=t3-connect",
    );
  });

  it("queues setup actions so an existing terminal can open them as tabs", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("claude-login"));
    enqueueTerminalLaunch(createTerminalLaunchPath("codex-login"));

    expect(drainTerminalLaunchQueue().map((launch) => launch.action)).toEqual([
      "claude-login",
      "codex-login",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("drains only launches targeted at the active terminal window", () => {
    enqueueTerminalLaunch(createTerminalLaunchPath("claude-login"), "terminal-a");
    enqueueTerminalLaunch(createTerminalLaunchPath("codex-login"), "terminal-b");
    enqueueTerminalLaunch(createTerminalLaunchPath("github-ssh-login"));

    expect(drainTerminalLaunchQueue("terminal-a").map((launch) => launch.action)).toEqual([
      "claude-login",
      "github-ssh-login",
    ]);
    expect(drainTerminalLaunchQueue("terminal-b").map((launch) => launch.action)).toEqual([
      "codex-login",
    ]);
    expect(drainTerminalLaunchQueue()).toEqual([]);
  });

  it("queues a fixed action without inventing a non-canonical terminal path", () => {
    expect(enqueueTerminalLaunchAction("t3-connect", "terminal-a")).toBe(true);

    expect(drainTerminalLaunchQueue("terminal-a").map((launch) => launch.action)).toEqual([
      "t3-connect",
    ]);
  });

  it("keeps the handoff URL when durable queueing fails", () => {
    window.history.replaceState(
      {},
      "",
      "/?launch=__terminal__&terminal_action=t3-connect",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });

    const queued = enqueueTerminalLaunchAction("t3-connect", "terminal-a");
    if (queued) consumeTerminalLaunchActionFromLocation();

    expect(queued).toBe(false);
    expect(window.location.search).toBe(
      "?launch=__terminal__&terminal_action=t3-connect",
    );
  });
});
