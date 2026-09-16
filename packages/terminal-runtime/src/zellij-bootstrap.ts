import { link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MATRIX_TERMINAL_BASHRC,
  MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT,
  MATRIX_TERMINAL_ZSHENV,
  MATRIX_TERMINAL_ZSHRC,
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

/** Bootstrap missing OS defaults without replacing owner customizations. */
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
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
