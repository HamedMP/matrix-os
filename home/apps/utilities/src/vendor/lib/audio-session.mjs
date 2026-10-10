// Audio files are deliberately kept in memory in Matrix Utilities.
/** @returns {Promise<ReturnType<typeof import("./audio-tools.mjs").normalizeAudioSessionManifest> & {files: Map<string, Blob>}>} */
export async function readAudioSession() {
  throw new Error("Files stay in the current Utilities window. Reloading closes this session.");
}
/** @param {string} id @param {Blob} file */
export async function saveAudioSessionFile(id, file) {}
/** @param {unknown} manifest */
export async function saveAudioSessionManifest(manifest) {}
/** @param {string} id */
export async function deleteAudioSessionFile(id) {}
export async function clearAudioSession() {}
