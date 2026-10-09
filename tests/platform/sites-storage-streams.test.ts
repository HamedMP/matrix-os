import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from '../../packages/platform/src/r2-client.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const owner = { ownerId: 'user_streams', machineId: '71c699b6-5576-433c-9f04-83d2220567ea', appSlug: 'event' };
const html = '<!doctype html><html><head></head><body>Public event</body></html>';
const js = 'console.log("event")';
const edgeSecret = 'production-stream-edge-secret-at-least-32';
const deployment = { title: 'Event', config: {}, files: [
  { path: 'index.html', contentType: 'text/html', body: Buffer.from(html).toString('base64') },
  { path: 'assets/main.js', contentType: 'text/javascript', body: Buffer.from(js).toString('base64') },
] };
let db: PlatformDB;
let storage: Awaited<ReturnType<typeof createR2Client>>;
let service: ReturnType<typeof createSitesService>;
let site: Awaited<ReturnType<typeof service.deploy>>;
let getBody: (key: string, signal: AbortSignal) => unknown | Promise<unknown>;
let streams: Readable[];
const readBegan = () => Promise.withResolvers<void>();
const asset = () => service.asset(site.id, site.activeVersion!, 'assets/main.js');

beforeAll(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, { ...owner, clerkUserId: owner.ownerId, handle: 'streams-owner', status: 'running', provisionedAt: new Date().toISOString() });
});
beforeEach(async () => {
  await db.executor.deleteFrom('public_sites').execute();
  streams = [];
  getBody = (key) => {
    const body = Readable.from([Buffer.from(key.endsWith('index.html') ? html : js)]);
    streams.push(body);
    return body;
  };
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any, options: any) => {
    if (command instanceof PutObjectCommand) return { ETag: '"uploaded"' } as any;
    if (command instanceof GetObjectCommand) return { Body: await getBody(command.input.Key!, options.abortSignal) } as any;
    throw new Error('Unexpected object-store command');
  });
  storage = await createR2Client({ endpoint: 'https://r2.example.com', accessKeyId: 'test', secretAccessKey: 'test', bucket: 'private-sites' });
  service = createSitesService({ db, storage });
  site = await service.deploy(owner, deployment);
});
afterEach(() => {
  for (const stream of streams) stream.destroy();
  storage.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => { await destroyTestPlatformDb(db); });

it('serves public frame and JavaScript from production R2 Node Readable bodies', async () => {
  const app = createSitePublicRoutes({ service, edgeSecret, submit: async () => ({ accepted: true }) });
  const request = (path: string) => app.request(path, { headers: { 'x-matrix-sites-edge': edgeSecret } });
  const frame = await request(`/${site.id}/frame`);
  expect(frame.status).toBe(200);
  expect(await frame.text()).toContain('Public event');
  const script = await request(`/${site.id}/assets/${site.activeVersion}/assets/main.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toBe('text/javascript');
  expect(await script.text()).toBe(js);
  expect(streams.every(stream => stream.destroyed)).toBe(true);
});

it('retains Web ReadableStream support and unlocks the completed stream', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(js)); controller.close(); } });
  getBody = () => body;
  expect((await asset()).body.toString()).toBe(js);
  expect(body.locked).toBe(false);
});

it.each(['overflow', 'truncated', 'invalid chunk', 'source failure'] as const)('rejects %s and destroys the production Node source', async (kind) => {
  const body = new Readable({ objectMode: kind === 'invalid chunk', autoDestroy: false, read() {
    if (kind === 'source failure') { this.destroy(new Error('provider-private-detail')); return; }
    this.push(kind === 'invalid chunk' ? { data: 'unbounded' } : Buffer.from(kind === 'overflow' ? `${js}extra` : 'short'));
    if (kind === 'truncated') this.push(null);
  } });
  streams.push(body);
  getBody = () => body;
  await expect(asset()).rejects.toThrow('unavailable');
  expect(body.destroyed).toBe(true);
});

it('bounds stalled Node consumption to 30 seconds even if the SDK ignores abort after headers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const began = readBegan();
  const body = new Readable({ read() { began.resolve(); } });
  streams.push(body);
  let signal: AbortSignal | undefined;
  getBody = (_, received) => { signal = received; began.resolve(); return body; };
  let outcome: unknown;
  const pending = asset().then(value => { outcome = value; }, error => { outcome = error; });
  await began.promise;
  await new Promise(setImmediate);
  try {
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveProperty('code', 'unavailable');
    expect(signal?.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { body.destroy(); await pending; }
});

it('includes acquisition time in the same 30 second body deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const began = readBegan();
  const body = new Readable({ read() {} });
  streams.push(body);
  getBody = async () => { began.resolve(); await new Promise(resolve => setTimeout(resolve, 20_000)); return body; };
  let outcome: unknown;
  const pending = asset().then(value => { outcome = value; }, error => { outcome = error; });
  await began.promise;
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveProperty('code', 'unavailable');
    expect(body.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { body.destroy(); await pending; }
});

it('bounds acquisition when the SDK ignores abort and destroys a late returned body', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const began = readBegan();
  const finish = Promise.withResolvers<Readable>();
  getBody = () => { began.resolve(); return finish.promise; };
  const body = new Readable({ read() {} });
  streams.push(body);
  let outcome: unknown;
  const pending = asset().then(value => { outcome = value; }, error => { outcome = error; });
  await began.promise;
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toHaveProperty('code', 'unavailable');
    expect(vi.getTimerCount()).toBe(0);
  } finally { finish.resolve(body); await pending; await new Promise(setImmediate); }
  expect(body.destroyed).toBe(true);
});

it('clears the deadline on successful Node consumption', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect((await asset()).body.toString()).toBe(js);
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a stalled Web stream without waiting for a hanging cancellation callback', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const began = readBegan();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  getBody = () => { began.resolve(); return body; };
  let outcome: unknown;
  const pending = asset().then(value => { outcome = value; }, error => { outcome = error; });
  await began.promise;
  await new Promise(setImmediate);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(outcome).toHaveProperty('code', 'unavailable');
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await pending;
});
