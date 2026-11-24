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
});
