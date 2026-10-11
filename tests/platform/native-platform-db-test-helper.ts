import { randomUUID } from 'node:crypto';
import { PostgresDialect } from 'kysely';
import pg, { type Pool, type PoolConfig } from 'pg';
import { afterAll, afterEach } from 'vitest';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createTestPlatformDb as createPGliteDb,
  destroyTestPlatformDb as destroyPGliteDb,
} from './platform-db-test-helper.js';

const MAX_CLONES = 4;
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
interface Dependencies {
  createPool(config: PoolConfig): Pool;
  createPlatformDb(options: { dialect: unknown }): PlatformDB;
}
interface Resource {
  name: string;
  pool?: Pool;
  closePool?: () => Promise<void>;
  poolClosed: boolean;
  closing?: Promise<void>;
}
export interface NativePlatformFixtureManager {
  createTestPlatformDb(url?: string): Promise<{ db: PlatformDB }>;
  destroyTestPlatformDb(db: PlatformDB | undefined): Promise<void>;
  drainClones(): Promise<void>;
  shutdown(): Promise<void>;
}
function log(stage: string, error: unknown): void {
  console.error(`[native-platform-fixture] ${stage}:`, error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure');
}
async function deadline<T>(stage: string, task: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native platform fixture ${stage} deadline exceeded`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function throwErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, message);
}
function flattened(error: unknown): unknown[] { return error instanceof AggregateError ? error.errors : [error]; }
function validateUrl(url: string): string {
  if (url.length > 4096) throw new Error('Native platform fixture URL exceeds its limit');
  let parsed: URL;
  try { parsed = new URL(url); }
  catch (error) {
    console.error('[native-platform-fixture] URL parsing failed:', error instanceof Error ? error.name : 'Unknown failure');
    throw new Error('Native platform fixture URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== '/matrix_ci_platform_fixture_admin' || parsed.search || parsed.hash) {
    throw new Error('Native platform fixture requires a literal-loopback disposable admin database without URL options');
  }
  return parsed.href;
}

/** One isolated test module owns one closed template and four reusable clone name slots. */
export function createNativePlatformFixtureManager(overrides: Partial<Dependencies> = {}): NativePlatformFixtureManager {
  const dependencies: Dependencies = { createPool: config => new pg.Pool(config), createPlatformDb, ...overrides };
  const prefix = `matrix_ci_platform_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const templateName = `${prefix}_template`;
  const cloneNames = Array.from({ length: MAX_CLONES }, (_, index) => `${prefix}_clone_${index}`);
  const allowedNames = [templateName, ...cloneNames];
  const reserved = new Set<string>(); // Cap four; release only after clone cleanup.
  const resources = new Map<string, Resource>(); // Cap five; remove on complete cleanup.
  const pending = new Set<Promise<{ db: PlatformDB }>>(); // Cap four total native/fallback factories; remove on settlement.
  const fallbackDbs = new Set<PlatformDB>(); // Cap four; remove on owner teardown.
  const nativeClose = new WeakMap<PlatformDB, () => Promise<void>>(); // Closed DB references do not remain retained.
  let fallbackPending = 0;
  let admin: Pool | undefined;
  let activeUrl: string | undefined;
  let templatePromise: Promise<void> | undefined;
  let closed = false;
  let epoch = Symbol('fixture admission');
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let adminClosure: Promise<void> | undefined;

  function identifier(name: string): string {
    if (!allowedNames.includes(name)) throw new Error('Native platform fixture database is outside its fixed allowlist');
    return `"${name}"`;
  }
  function pool(url: string): Pool {
    const value = dependencies.createPool({ connectionString: url, max: 1,
      connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000,
      statement_timeout: 5000, query_timeout: 7000, options: '-c lock_timeout=2000' });
    value.on('error', error => log('Idle pool failure', error));
    return value;
  }
  function getAdmin(url: string): Pool {
    if (activeUrl && activeUrl !== url) throw new Error('Native platform fixture URL cannot change within a module');
    activeUrl = url;
    admin ??= pool(url);
    return admin;
  }
  async function query(statement: string, values?: unknown[]): Promise<pg.QueryResult> {
    if (!admin) throw new Error('Native platform fixture admin pool is unavailable');
    return deadline('admin query', admin.query(statement, values), 10_000);
  }
  async function closePool(resource: Resource): Promise<void> {
    if (resource.poolClosed) return;
    if (resource.closePool) await deadline('pool closure', resource.closePool(), 10_000);
    else if (resource.pool) await deadline('unowned pool closure', resource.pool.end(), 10_000);
    resource.poolClosed = true;
  }
  function cleanup(resource: Resource): Promise<void> {
    resource.closing ??= (async () => {
      const errors: unknown[] = [];
      try { await closePool(resource); } catch (error) { log('Pool cleanup failed', error); errors.push(error); }
      try { await query(`DROP DATABASE IF EXISTS ${identifier(resource.name)} WITH (FORCE)`); }
      catch (error) { log('Database cleanup failed', error); errors.push(error); }
      if (errors.length) {
        resource.closing = undefined; // A subsequent drain retries failed cleanup.
        throwErrors(errors, 'Native platform fixture cleanup failed');
      }
      resources.delete(resource.name); reserved.delete(resource.name);
    })();
    return resource.closing;
  }
  function createResource(name: string, template: string): { resource: Resource; ready: Promise<unknown> } {
    if (resources.size >= allowedNames.length || resources.has(name)) throw new Error('Native platform fixture resource cap exceeded');
    const resource: Resource = { name, poolClosed: false };
    resources.set(name, resource); // Register before DDL so partial creation is still cleaned up.
    const ready = query(`CREATE DATABASE ${identifier(name)} TEMPLATE ${template === 'template0' ? 'template0' : identifier(template)} ALLOW_CONNECTIONS true`);
    return { resource, ready };
  }
  function compose(resource: Resource, url: string): PlatformDB {
    const target = new URL(url); target.pathname = `/${resource.name}`;
    resource.pool = pool(target.href);
    const db = dependencies.createPlatformDb({ dialect: new PostgresDialect({ pool: resource.pool }) });
    resource.closePool = db.destroy.bind(db);
    return db;
  }
  async function disposeFailure(resource: Resource | undefined, error: unknown): Promise<never> {
    log('Initialization failed', error);
    if (resource) {
      try { await cleanup(resource); }
      catch (cleanupError) {
        log('Initialization cleanup failed', cleanupError);
        throw new AggregateError([error, ...flattened(cleanupError)], 'Native platform fixture initialization and cleanup failed');
      }
    }
    throw error;
  }
  function getTemplate(url: string): Promise<void> {
    templatePromise ??= (async () => {
      const previous = resources.get(templateName);
      if (previous) await cleanup(previous);
      try {
        const { resource, ready } = createResource(templateName, 'template0');
        await ready;
        if (closed || resource.poolClosed) throw new Error('Native platform fixture template closed before pool creation');
        const db = compose(resource, url);
        await deadline('template startup', db.ready);
        if (closed || resource.poolClosed) throw new Error('Native platform fixture template closed during startup');
        const size = await query('SELECT pg_database_size($1)::text AS bytes', [templateName]);
        const bytes = Number(size.rows[0]?.bytes);
        if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_TEMPLATE_BYTES) throw new Error('Native platform fixture template exceeds its nonempty 64 MiB limit');
        await closePool(resource);
        const connections = await query('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', [templateName]);
        if (Number(connections.rows[0]?.count) !== 0) throw new Error('Native platform fixture template still has connections');
        await query(`ALTER DATABASE ${identifier(templateName)} ALLOW_CONNECTIONS false`);
      } catch (error) { await disposeFailure(resources.get(templateName), error); }
    })().catch(error => {
      templatePromise = undefined;
      log('Template cache cleared for retry', error);
      throw error;
    });
    return templatePromise;
  }
  function trackTask(task: Promise<{ db: PlatformDB }>): Promise<{ db: PlatformDB }> {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function create(url = process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL): Promise<{ db: PlatformDB }> {
    if (closed) throw new Error('Native platform fixture manager is closed');
    if (draining) throw new Error('Native platform fixture manager is draining');
    const admittedEpoch = epoch;
    if (pending.size >= MAX_CLONES) throw new Error('Native platform fixture pending cap exceeded');
    if (url === undefined) {
      if (fallbackDbs.size + fallbackPending >= MAX_CLONES) throw new Error('Platform fallback fixture cap exceeded');
      fallbackPending++;
      return trackTask((async () => {
        try {
          const { db } = await createPGliteDb();
          // Own the database before any teardown attempt; failed late cleanup
          // must remain visible to a later drain, just like published fixtures.
          fallbackDbs.add(db);
          if (closed || admittedEpoch !== epoch) {
            const failure = new Error('Native platform fixture manager closed or drained during fallback startup');
            try { await destroy(db); }
            catch (cleanupError) {
              log('Late fallback cleanup failed', cleanupError);
              throw new AggregateError([failure, cleanupError], 'Platform fallback startup and cleanup failed');
            }
            throw failure;
          }
          return { db };
        } finally { fallbackPending--; }
      })());
    }
    const validated = validateUrl(url);
    const name = cloneNames.find(candidate => !reserved.has(candidate));
    if (!name || pending.size >= MAX_CLONES) throw new Error('Native platform fixture clone cap exceeded');
    getAdmin(validated); reserved.add(name);
    const task = (async () => {
      let resource: Resource | undefined;
      try {
        await getTemplate(validated);
        if (closed || admittedEpoch !== epoch) throw new Error('Native platform fixture manager closed or drained before clone creation');
        const allocated = createResource(name, templateName);
        resource = allocated.resource;
        await allocated.ready;
        if (closed || resource.poolClosed || admittedEpoch !== epoch) throw new Error('Native platform fixture database closed or drained before pool creation');
        const db = compose(resource, validated);
        await deadline('clone startup', db.ready);
        if (closed || resource.poolClosed || admittedEpoch !== epoch) throw new Error('Native platform fixture database closed or drained before clone publication');
        const ownedResource = resource;
        const close = () => cleanup(ownedResource);
        nativeClose.set(db, close); db.destroy = close;
        return { db };
      } catch (error) { return disposeFailure(resource, error); }
      finally { if (!resources.has(name)) reserved.delete(name); }
    })();
    return trackTask(task);
  }
  async function destroy(db: PlatformDB | undefined): Promise<void> {
    if (!db) return;
    const close = nativeClose.get(db);
    if (close) await close();
    else { await destroyPGliteDb(db); fallbackDbs.delete(db); }
  }
  function drainClones(): Promise<void> {
    if (drainPromise) return drainPromise;
    // Invalidate every admitted factory even if its startup outlives the drain
    // deadline. A later test may create fixtures only after this drain finishes.
    epoch = Symbol('fixture admission'); draining = true;
    drainPromise = drainPendingAndClones().finally(() => { draining = false; drainPromise = undefined; });
    return drainPromise;
  }
  async function drainPendingAndClones(): Promise<void> {
    const errors: unknown[] = [];
    try {
      const settled = await deadline('pending clone drain', Promise.allSettled([...pending]));
      for (const result of settled) {
        if (result.status === 'rejected') { log('Pending clone failed during drain', result.reason); errors.push(result.reason); }
      }
    } catch (error) { log('Pending clone drain deadline failed', error); errors.push(error); }
    // A deadline must not bypass cleanup of resources already allocated.

    const cleanupTasks = [...resources.values()].filter(resource => resource.name !== templateName).map(cleanup);
    cleanupTasks.push(...[...fallbackDbs].map(destroy));
    for (const result of await Promise.allSettled(cleanupTasks)) {
      if (result.status === 'rejected') { log('Clone drain failed', result.reason); errors.push(result.reason); }
    }
    throwErrors(errors, 'Native platform fixture clone drain failed');
  }
  function shutdown(): Promise<void> {
    closed = true;
    shutdownPromise ??= (async () => {
      const errors: unknown[] = [];
      try { await drainClones(); } catch (error) { log('Shutdown clone drain failed', error); errors.push(...flattened(error)); }
      const template = resources.get(templateName);
      if (template) {
        try { await cleanup(template); } catch (error) { log('Shutdown template cleanup failed', error); errors.push(...flattened(error)); }
      }
      if (admin && !adminClosure) {
        try {
          const remaining = await query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [allowedNames]);
          if (remaining.rows.length) throw new Error('Native platform fixture databases remain after shutdown');
        } catch (error) { log('Shutdown database verification failed', error); errors.push(error); }
      }
      // Failed drops and uncertain verification retain their owner connection
      // and registry entries. A rejected shutdown is retryable, not terminal.
      if (!errors.length && (resources.size || pending.size || fallbackDbs.size)) {
        errors.push(new Error('Native platform fixture resources remain after shutdown'));
      }
      if (admin && !errors.length) {
        const owner = admin;
        // Keep the actual close promise when only its waiting deadline expires.
        // pg rejects a second end(), and an ending pool cannot verify databases.
        adminClosure ??= Promise.resolve().then(() => owner.end()).then(() => {
          if (admin === owner) admin = undefined;
        }).catch(error => {
          adminClosure = undefined;
          if (owner.ended && admin === owner) admin = undefined;
          throw error;
        });
        try { await deadline('admin closure', adminClosure, 10_000); }
        catch (error) { log('Shutdown admin cleanup failed', error); errors.push(error); }
      }
      throwErrors(errors, 'Native platform fixture shutdown failed');
    })().catch(error => {
      shutdownPromise = undefined;
      throw error;
    });
    return shutdownPromise;
  }
  return { createTestPlatformDb: create, destroyTestPlatformDb: destroy, drainClones, shutdown };
}

const manager = createNativePlatformFixtureManager();
// Suites explicitly destroy fixtures after each case; these drains also own
// resources left behind by failed startup/assertions and verify final cleanup.
afterEach(() => manager.drainClones(), 60_000);
afterAll(() => manager.shutdown(), 120_000);
export const createTestPlatformDb = () => manager.createTestPlatformDb();
export const destroyTestPlatformDb = (db: PlatformDB | undefined) => manager.destroyTestPlatformDb(db);
