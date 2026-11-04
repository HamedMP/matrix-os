// Resolve relative runtime imports from their caller, not from this helper.
export function createRuntimeModuleImporter(callerModuleUrl: string) {
  const sourceMode = new URL(callerModuleUrl).pathname.endsWith('.ts');
  return async function importRuntimeModule<T>(specifier: string): Promise<T> {
    // These are internal, constant Gateway specifiers. Compiled Platform keeps
    // its dist contract; source development joins the real tsx source graph.
    const runtimeSpecifier = sourceMode
      ? specifier.replace(/^(\.\.\/\.\.\/gateway\/)dist\/(.+)\.js$/, '$1src/$2.ts')
      : specifier;
    const target = runtimeSpecifier.startsWith('./') || runtimeSpecifier.startsWith('../')
      ? new URL(runtimeSpecifier, callerModuleUrl).href
      : runtimeSpecifier;
    return import(target) as Promise<T>;
  };
}
