import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MATRIX_TERMINAL_BASHRC,
  MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT,
  MATRIX_TERMINAL_ZSHENV,
  MATRIX_TERMINAL_ZSHRC,
  MATRIX_ZELLIJ_INDEPENDENT_FOCUS,
  MATRIX_ZELLIJ_LAYOUT,
  matrixTerminalShellScript,
  matrixZellijConfigPaths,
  renderMatrixZellijConfig,
} from "./zellij-config.js";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function assertRegularFileOrMissing(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error("terminal_config_not_regular_file");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

const LEGACY_MIRRORED_FOCUS = `// All Matrix clients share a session focus, including scoped CLI pane actions.
mirror_session true`;

async function upgradeLegacyConfig(paths: ReturnType<typeof matrixZellijConfigPaths>, staging: string): Promise<void> {
  // Match the complete old generated config, including its shell path and theme.
  // A generated header or matching setting alone is insufficient to identify it.
  const candidates = (["dark", "light", "matrix"] as const).map((theme) => {
    const updated = renderMatrixZellijConfig(paths, theme);
    const legacy = Buffer.from(updated.replace(MATRIX_ZELLIJ_INDEPENDENT_FOCUS, LEGACY_MIRRORED_FOCUS));
    return { updated, legacy };
  });
  const handle = await open(paths.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
  if (!handle) return;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !candidates.some(({ legacy }) => legacy.length === before.size)) return;
    const content = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(content);
    if (bytesRead !== before.size) return;
    const match = candidates.find(({ legacy }) => legacy.equals(content.subarray(0, bytesRead)));
    if (!match) return;

    const upgraded = join(staging, "config-upgrade");
    await writeFile(upgraded, match.updated, { flag: "wx", mode: 0o600 });
    await chmod(upgraded, before.mode & 0o777);
    const latest = await lstat(paths.file);
    if (latest.dev !== before.dev || latest.ino !== before.ino || latest.nlink !== before.nlink
      || latest.size !== before.size || latest.mtimeMs !== before.mtimeMs || latest.ctimeMs !== before.ctimeMs) return;
    await rename(upgraded, paths.file);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  } finally {
    await handle.close();
  }
}

/** Bootstrap OS defaults and upgrade the exact legacy generated config. */
export async function initializeMatrixZellijConfig(homePath: string): Promise<void> {
  const home = resolve(homePath);
  const paths = matrixZellijConfigPaths(home);
  if (!(await lstat(home)).isDirectory()) throw new Error("terminal_home_not_directory");
  // Create/check each parent separately so a pre-existing symlink is never followed.
  for (const directory of [join(home, "system"), paths.dir, paths.layoutDir]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    if (!(await lstat(directory)).isDirectory()) throw new Error("terminal_config_not_directory");
  }
  const assets: Array<[string, string, number]> = [
    [paths.shellFile, matrixTerminalShellScript(paths.zshrcFile, paths.bashrcFile, paths.promptLabelFile), 0o700],
    [paths.zshenvFile, MATRIX_TERMINAL_ZSHENV, 0o600],
    [paths.zshrcFile, MATRIX_TERMINAL_ZSHRC, 0o600],
    [paths.bashrcFile, MATRIX_TERMINAL_BASHRC, 0o600],
    [paths.promptLabelFile, MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT, 0o600],
    [paths.layoutFile, MATRIX_ZELLIJ_LAYOUT, 0o600],
    // Publish the config only after all files it references are complete.
    [paths.file, renderMatrixZellijConfig(paths), 0o600],
  ];
  for (const [path] of assets) await assertRegularFileOrMissing(path);
  const staging = await mkdtemp(join(paths.dir, ".bootstrap-"));
  try {
    for (const [index, [path, content, mode]] of assets.entries()) {
      const temporary = join(staging, String(index));
      await writeFile(temporary, content, { flag: "wx", mode });
      try {
        // Unlike rename, link atomically publishes without clobbering an existing file.
        await link(temporary, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        await assertRegularFileOrMissing(path);
        if (path === paths.file) await upgradeLegacyConfig(paths, staging);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
