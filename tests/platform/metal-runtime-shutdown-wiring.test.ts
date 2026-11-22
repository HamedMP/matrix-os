import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Metal maintenance shutdown wiring (spec 2691, ENG-520). Startup-failure
 * cleanups run only when startup throws, so a normal SIGTERM must stop the
 * metal maintenance timer and drain its pass (reconcileStale writes, drainOnce
 * hostd deletes) before the primary pool closes. Fault detected: a pass cut off
 * with the pool closed underneath it, and a timer that keeps running.
 */
describe('metal runtime shutdown wiring', () => {
  it('stops the maintenance timer on SIGTERM and drains it before the primary pool closes', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    // Startup-failure path keeps its registration.
    expect(source).toContain('registerCustomMcpStartupCleanup(async () => { await metalRuntime?.shutdown(); });');
    const shutdown = source.slice(source.indexOf('const shutdown = (signal:'));
    const stopIndex = shutdown.indexOf('metalRuntime?.stop()');
    const closeIndex = shutdown.indexOf('(server as Server).close(');
    expect(stopIndex).toBeGreaterThan(0);
    expect(stopIndex).toBeLessThan(closeIndex);
    // The drain starts before any other awaited step, so an earlier rejection cannot skip it.
    const startIndex = shutdown.indexOf('const metalShutdown = metalRuntime?.shutdown()');
    expect(startIndex).toBeGreaterThan(closeIndex);
    expect(startIndex).toBeLessThan(shutdown.indexOf('await accountDeletion?.drain()'));
    const drainIndex = shutdown.indexOf('await metalShutdown;');
    expect(drainIndex).toBeGreaterThan(startIndex);
    expect(drainIndex).toBeLessThan(shutdown.indexOf('await Promise.allSettled(['));
    expect(drainIndex).toBeLessThan(shutdown.indexOf('closePrimaryDb()'));
  });

  it('gives the idle sleeper the substrate registry and platform secret, and drains it with the metal runtime', async () => {
    const startup = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    const composed = startup.slice(startup.indexOf('const metalRuntime = createConfiguredMetalRuntime({'));
    expect(composed.slice(0, composed.indexOf('});'))).toContain('substrates: substrateRegistry, platformSecret');
    // The sleeper's stop and drain live in the metal runtime, so the SIGTERM wiring above covers them.
    const runtime = await readFile('packages/platform/src/substrates/metal-runtime.ts', 'utf8');
    const stop = runtime.slice(runtime.indexOf('    stop() {'), runtime.indexOf('    shutdown() {'));
    expect(stop).toContain('sleeper?.stop();');
    const shutdown = runtime.slice(runtime.indexOf('    shutdown() {'));
    const drain = shutdown.indexOf('await Promise.all([worker?.drain(), sleeper?.drain()]);');
    expect(drain).toBeGreaterThan(shutdown.indexOf('sleeper?.stop();'));
    expect(drain).toBeLessThan(shutdown.indexOf('await dispatcher.close();'));
  });

  it('binds the metal resume hook to the managed-feature resume trigger and stops and drains it on shutdown', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    // The registry's metal hook forwards to the late-bound trigger.
    const registry = source.indexOf('const substrateRegistry = createPlatformSubstrateRegistry(db, process.env, {');
    expect(registry).toBeGreaterThan(0);
    expect(source.slice(registry, source.indexOf('});', registry))).toContain('onMetalResumed: (ref) => activateResumedRuntime?.(ref)');
    const bind = source.indexOf('activateResumedRuntime = createManagedFeatureResumeTrigger(activateManagedFeatures);');
    expect(bind).toBeGreaterThan(source.indexOf('activateManagedFeatures = createManagedFeatureActivator('));
    // Every wake source (HTTP server, metal sleeper) starts after the bind.
    expect(bind).toBeLessThan(source.indexOf('const metalRuntime = createConfiguredMetalRuntime({'));
    // Startup-failure cleanup stops and drains it with the other workers.
    const cleanup = source.slice(source.indexOf('registerCustomMcpStartupCleanup(createPlatformStartupWorkerCleanup(() => ['));
    expect(cleanup.slice(0, cleanup.indexOf(']));'))).toContain('activateResumedRuntime,');
    // SIGTERM: stopped before the server closes, drained before the primary pool closes.
    const shutdown = source.slice(source.indexOf('const shutdown = (signal:'));
    const stop = shutdown.indexOf('activateResumedRuntime?.stop();');
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(shutdown.indexOf('(server as Server).close('));
    const drain = shutdown.indexOf('await activateResumedRuntime?.drain();');
    expect(drain).toBeGreaterThan(shutdown.indexOf('(server as Server).close('));
    expect(drain).toBeLessThan(shutdown.indexOf('closeUpstreamDispatchers()'));
    expect(drain).toBeLessThan(shutdown.indexOf('closePrimaryDb()'));
  });
});
