import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { bootstrapSiteSubmissionDatabase } from '../../packages/gateway/src/sites/bootstrap.js';
import { registerSiteRuntime } from '../../packages/gateway/src/sites/wiring.js';
const mocks = vi.hoisted(() => ({
 options: [] as any[], query: vi.fn(), release: vi.fn(), end: vi.fn(async () => {}),
}));
vi.mock('pg', () => ({ default: { Pool: class {
 constructor(options: unknown) { mocks.options.push(options); }
 on = vi.fn(); end = mocks.end;
 connect = async () => ({ query: mocks.query, release: mocks.release });
} } }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); mocks.options.length = 0; });
describe('owned site bootstrap pool', () => {
 it('uses bounded connection, server execution, lock, and client read deadlines', async () => {
  mocks.query.mockResolvedValue({ command: 'SELECT', rows: [], rowCount: 0 });
  await bootstrapSiteSubmissionDatabase('postgresql://synthetic/test');
  expect(mocks.options).toEqual([expect.objectContaining({ max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7500, lock_timeout: 2000 })]);
  expect(mocks.release).toHaveBeenCalledWith();
  expect(mocks.end).toHaveBeenCalledOnce();
 });
 it('destroys a timed-out socket before pool shutdown and never queues rollback on it', async () => {
  mocks.query.mockResolvedValue({ command: 'SELECT', rows: [], rowCount: 0 });
  mocks.query.mockImplementation(async (query: string) => {
   if (query.includes('CREATE TABLE')) throw new Error('Query read timeout');
   return { command: 'SELECT', rows: [], rowCount: 0 };
  });
  await expect(bootstrapSiteSubmissionDatabase('postgresql://synthetic/test')).rejects.toThrow();
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(mocks.query.mock.calls.some(([query]) => query === 'rollback')).toBe(false);
  expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.end.mock.invocationCallOrder[0]);
 });
 it('fails optional storage closed but still registers routes after an owned setup timeout', async () => {
  mocks.query.mockRejectedValue(new Error('Query read timeout'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const shared = { destroy: vi.fn(), transaction: vi.fn() } as any;
  const app = new Hono();
  await registerSiteRuntime(app, { homePath: '/unused', db: shared, env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://synthetic/test', MATRIX_USER_ID: 'owner' } });
  expect(shared.destroy).not.toHaveBeenCalled(); expect(shared.transaction).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true); expect(mocks.end).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith('[sites] Submission database unavailable', 'Error');
  expect((await app.request('/api/apps/event/site')).status).toBe(401);
 });
});
