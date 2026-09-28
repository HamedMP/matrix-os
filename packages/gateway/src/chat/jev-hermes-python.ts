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
  return isolatedArguments(root, cachePrefix, [
    // Explicit-key SDK path precedes auth-store/pool resolution. Never copy a refresh grant.
    "if os.environ.get('MATRIX_JEV_PRIMARY_KEY'):",
    "    from hermes_cli import runtime_provider as runtime",
    "    key = os.environ.pop('MATRIX_JEV_PRIMARY_KEY')",
    "    provider = os.environ['MATRIX_JEV_PRIMARY_PROVIDER']",
    "    model = os.environ['MATRIX_JEV_PRIMARY_MODEL']",
    "    url = os.environ['MATRIX_JEV_PRIMARY_URL']",
    "    mode = os.environ['MATRIX_JEV_PRIMARY_MODE']",
    "    original = runtime.resolve_runtime_provider",
    "    def restricted_runtime(*, requested=None, target_model=None, explicit_api_key=None, explicit_base_url=None):",
    "        if requested not in (None, provider) or target_model not in (None, model):",
    "            raise RuntimeError('Restricted model route unavailable')",
    "        value = original(requested=provider, target_model=model, explicit_api_key=key, explicit_base_url=url)",
    "        if value.get('provider') != provider or value.get('base_url') != url or value.get('api_mode') != mode or value.get('credential_pool'):",
    "            raise RuntimeError('Restricted model route unavailable')",
    "        return value",
    "    runtime.resolve_runtime_provider = restricted_runtime",
    "runpy.run_module('tui_gateway.entry', run_name='__main__')",
  ].join("\n"), true);
}
export function hermesDependencyArguments(root: string, cachePrefix: string): string[] {
  return isolatedArguments(root, cachePrefix, 'import anthropic, openai; import importlib.metadata; print(importlib.metadata.version("anthropic")); print(importlib.metadata.version("openai"))', false);
}
