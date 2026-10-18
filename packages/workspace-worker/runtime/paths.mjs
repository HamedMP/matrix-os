/** Runtime identity is private configuration, never part of shared file projection. */
export const RUNTIME_PRIVATE_DIRECTORY = '.matrix-runtime';
export function isRuntimePrivatePath(path) {
  return typeof path === 'string'
    && (path === RUNTIME_PRIVATE_DIRECTORY || path.startsWith(`${RUNTIME_PRIVATE_DIRECTORY}/`));
}
