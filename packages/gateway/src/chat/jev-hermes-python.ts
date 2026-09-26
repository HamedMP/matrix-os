/** Skip Python site initialization in the restricted credential-bearing process.
 * Fixed verified source and installed dependencies are appended explicitly;
 * PYTHONPATH, user/sitecustomize and executable .pth hooks never execute.
 * A fresh private cache prefix bypasses owner source caches; -B avoids writes.
 * This does not authenticate every installed dependency's package bytes.
 */
function isolatedArguments(root: string, cachePrefix: string, body: string, includeSource: boolean): string[] {
  const bootstrap = [
    "import sys, os, runpy",
    `root = ${JSON.stringify(root)}`,
    "site = os.path.join(root, 'venv', 'lib', 'python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor), 'site-packages')",
    includeSource ? "sys.path.extend([root, site])" : "sys.path.append(site)",
    body,
  ].join("\n");
  return ["-I", "-S", "-B", "-X", `pycache_prefix=${cachePrefix}`, "-u", "-c", bootstrap];
}
export function restrictedHermesPythonArguments(root: string, cachePrefix: string): string[] {
  return isolatedArguments(root, cachePrefix, "runpy.run_module('tui_gateway.entry', run_name='__main__')", true);
}
export function hermesDependencyArguments(root: string, cachePrefix: string): string[] {
  return isolatedArguments(root, cachePrefix, 'import anthropic; import importlib.metadata; print(importlib.metadata.version("anthropic"))', false);
}
