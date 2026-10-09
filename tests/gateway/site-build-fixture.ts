import type { BuildOrchestrator } from '../../packages/gateway/src/app-runtime/build-orchestrator.js';
/** Test builders mimic the success-only capture protocol of the production orchestrator. */
export function siteBuildFixture<T extends { build: (...args: any[]) => Promise<any> }>(build: T): T & Pick<BuildOrchestrator, 'buildWithSnapshot'> {
 return Object.assign(build, {
  async buildWithSnapshot(slug: string, appDir: string, opts: { timeoutMs?: number }, collect: (result: any) => Promise<any>) {
   const result = await build.build(slug, appDir, opts);
   return result.ok ? { ...result, snapshot: await collect(result) } : result;
  },
 });
}
