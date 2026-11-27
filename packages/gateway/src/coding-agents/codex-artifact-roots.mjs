import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

function isWithin(root, path) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Where the runner may read provider-named artifact files from: the run's
 * own folders, plus Codex's `generated_images` folder for image items only.
 * Codex saves every generated image there (under CODEX_HOME, default
 * HOME/.codex), never in the run's working folder. The rest of CODEX_HOME
 * holds credentials and stays unreadable.
 *
 * @param {{ runRoots: string[], environment: NodeJS.ProcessEnv }} input
 */
export async function createCodexArtifactRoots({ runRoots, environment }) {
  const resolvedRunRoots = await Promise.all(runRoots.map((root) => realpath(root)));
  const codexHome = environment.CODEX_HOME || join(environment.HOME || homedir(), ".codex");
  const generatedImagesDirectory = resolve(codexHome, "generated_images");

  // Codex creates the folder on its first image, which can be after startup.
  async function generatedImagesRoot() {
    try {
      return await realpath(generatedImagesDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    /**
     * @param {string} resolvedPath a path already passed through realpath
     * @param {{ generatedImages: boolean }} options
     */
    async contains(resolvedPath, { generatedImages }) {
      if (resolvedRunRoots.some((root) => isWithin(root, resolvedPath))) return true;
      if (!generatedImages) return false;
      const root = await generatedImagesRoot();
      return root !== null && isWithin(root, resolvedPath);
    },
  };
}
