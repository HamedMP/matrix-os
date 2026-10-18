// Synthetic Linux/Docker experiment; no production gateway or security claims.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const now = () => performance.now();
const pause = () => new Promise((done) => setTimeout(done, 100));
const FILES = ['fixture.bin', 'state.json', 'database.sql'];

export async function verifyBackup(backup, owner) {
  if (backup.owner !== owner) throw new Error('owner mismatch');
  const root = await lstat(backup.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe checkpoint root');
  for (const [name, digest] of Object.entries(backup.hashes)) {
    if (!FILES.includes(name)) throw new Error('unexpected checkpoint file');
    const path = join(backup.root, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('unsafe checkpoint file');
    if (hash(await readFile(path)) !== digest) throw new Error('checkpoint checksum mismatch');
  }
}

export function verifyMutationState(acknowledged, mutated) {
  assert.equal(mutated.owner, acknowledged.owner);
  assert.equal(mutated.fileHash, acknowledged.fileHash);
  assert.equal(mutated.revision, acknowledged.revision + 1);
  assert.notEqual(mutated.rows, acknowledged.rows, 'SQL mutation missing');
}

export async function runCycle(adapter) {
  const acknowledged = await adapter.seed();
  const backup = await adapter.checkpoint(acknowledged);
  if (backup.owner !== acknowledged.owner) throw new Error('owner mismatch');
  await adapter.validate(backup);
  const deletion = await adapter.destroy();
  if (!deletion.containersDeleted || !deletion.volumesDeleted) throw new Error('destruction incomplete');
  await adapter.restore(backup);
  const restored = await adapter.read();
  assert.deepEqual(restored, acknowledged, 'restored state mismatch');
  const mutated = await adapter.mutate();
  verifyMutationState(acknowledged, mutated);
  await adapter.cleanup();
  return { acknowledged, restored, mutated, deletion };
}

export class DockerFixture {
  constructor({ checkpointRoot, owner = `synthetic-${randomBytes(8).toString('hex')}`, size = 1024 * 1024 }) {
    if (!/^synthetic-[a-z0-9-]{1,64}$/.test(owner)) throw new Error('invalid synthetic owner');
    this.owner = owner;
    this.root = resolve(checkpointRoot);
    this.size = size;
    this.token = randomBytes(24).toString('hex');
    this.run = `matrix-spike-${randomBytes(8).toString('hex')}`;
    this.names = [];
    this.metrics = {};
  }
  async docker(args, options = {}) {
    const result = await execute('docker', args, {
      timeout: 120_000, maxBuffer: 40 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, ...options,
    });
    return String(result.stdout).trim();
  }
  async owned(kind, name) {
    const object = JSON.parse(await this.docker([kind, 'inspect', name]))[0];
    if ((object.Config?.Labels ?? object.Labels)?.['matrix.spike'] !== this.run) throw new Error('resource ownership mismatch');
    return object;
  }
  async create(generation) {
    this.generation = generation;
    const suffix = `${this.run}-${generation}`;
    this.runtime = `${suffix}-node`;
    this.db = `${suffix}-pg`;
    this.volumes = [`${suffix}-files`, `${suffix}-db`];
    for (const volume of this.volumes) {
      await this.docker(['volume', 'create', '--label', `matrix.spike=${this.run}`, volume]);
      this.names.push(['volume', volume]);
    }
    const start = now();
    await this.docker(['run', '-d', '--name', this.db, '--label', `matrix.spike=${this.run}`, '--memory', '256m', '--cpus', '1',
      '--mount', `type=volume,source=${this.volumes[1]},target=/var/lib/postgresql/data`,
      '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture', '-e', `POSTGRES_PASSWORD=${this.token}`, 'postgres:17-bookworm']);
    this.names.push(['container', this.db]);
    await this.wait(async () => { await this.docker(['exec', this.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'fixture'], { timeout: 5000 }); });
    this.metrics[`${generation}PostgresReadyMs`] = now() - start;
    await this.docker(['create', '--name', this.runtime, '--label', `matrix.spike=${this.run}`, '--memory', '256m', '--cpus', '1',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64',
      '--publish', '127.0.0.1::8080', '--mount', `type=volume,source=${this.volumes[0]},target=/workspace`,
      '--mount', `type=bind,source=${join(here, 'runtime.mjs')},target=/runtime.mjs,readonly`,
      '-e', `SPIKE_OWNER=${this.owner}`, '-e', `SPIKE_TOKEN=${this.token}`, '-e', `SPIKE_GENERATION=${generation}`,
      'node:24-bookworm-slim', 'node', '/runtime.mjs']);
    this.names.push(['container', this.runtime]);
  }
  async wait(operation) {
    const deadline = now() + 30_000;
    let error;
    while (now() < deadline) {
      try { return await operation(); } catch (caught) { error = caught; await pause(); }
    }
    throw new Error('fixture readiness timeout', { cause: error });
  }
  async start() {
    const start = now();
    await this.docker(['start', this.runtime]);
    const info = await this.owned('container', this.runtime);
    this.url = `http://127.0.0.1:${info.NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
    const health = await this.wait(() => this.http('/health'));
    assert.equal(health.owner, this.owner);
    assert.equal(health.generation, this.generation);
    this.metrics[`${this.generation}NodeStartToHealthMs`] = now() - start;
    this.metrics[`${this.generation}ContainerId`] = info.Id;
    return health;
  }
  async http(path, method = 'GET') {
    const response = await fetch(`${this.url}${path}`, { method, headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('fixture HTTP failure');
    return response.json();
  }
  async sql(query) {
    return this.docker(['exec', this.db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fixture', '-d', 'fixture', '-At', '-c', query]);
  }
  async seed() {
    // Exclusive directory creation prevents overwriting any preexisting workspace.
    await mkdir(this.root, { mode: 0o700 });
    const start = now();
    await this.create('source');
    const seedDir = await mkdtemp(join(tmpdir(), 'matrix-fixture-'));
    try {
      await writeFile(join(seedDir, 'fixture.bin'), randomBytes(this.size));
      await writeFile(join(seedDir, 'state.json'), JSON.stringify({ owner: this.owner, revision: 1 }));
      for (const name of FILES.slice(0, 2)) await this.docker(['cp', join(seedDir, name), `${this.runtime}:/workspace/${name}`]);
    } finally { await rm(seedDir, { recursive: true, force: true }); }
    await this.sql(`CREATE TABLE fixture(id integer PRIMARY KEY, owner text NOT NULL, value text NOT NULL, revision integer NOT NULL); INSERT INTO fixture SELECT i, '${this.owner}', repeat(md5(i::text),8), 1 FROM generate_series(1,1000) i;`);
    await this.start();
    this.metrics.coldFixtureReadyMs = now() - start;
    const acknowledged = await this.read();
    await this.measure('source');
    return acknowledged;
  }
  async read() {
    const state = await this.http('/state');
    assert.equal(state.owner, this.owner);
    assert.equal(state.generation, this.generation);
    const rows = await this.sql("SELECT count(*) || ':' || sum(revision) || ':' || md5(string_agg(id || ':' || owner || ':' || value || ':' || revision, ',' ORDER BY id)) FROM fixture;");
    return { owner: state.owner, revision: state.revision, fileHash: state.fileHash, rows };
  }
  async checkpoint(acknowledged) {
    const start = now();
    await this.docker(['stop', '--time', '3', this.runtime]);
    for (const name of FILES.slice(0, 2)) await this.docker(['cp', `${this.runtime}:/workspace/${name}`, join(this.root, name)]);
    await this.docker(['exec', this.db, 'pg_dump', '-U', 'fixture', '-d', 'fixture', '--no-owner', '--no-acl']).then((dump) => writeFile(join(this.root, 'database.sql'), dump));
    const hashes = {};
    for (const name of FILES) hashes[name] = hash(await readFile(join(this.root, name)));
    const backup = { root: this.root, owner: this.owner, acknowledged, hashes, size: this.size };
    await writeFile(join(this.root, 'manifest.json'), JSON.stringify({ ...backup, root: undefined }, null, 2), { mode: 0o600 });
    this.metrics.checkpointMs = now() - start;
    return backup;
  }
  async validate(backup) {
    if (Object.keys(backup.hashes).sort().join(',') !== [...FILES].sort().join(',')) throw new Error('checkpoint files incomplete');
    await verifyBackup(backup, this.owner);
    const state = JSON.parse(await readFile(join(backup.root, 'state.json'), 'utf8'));
    assert.equal(state.owner, this.owner, 'owner mismatch');
    assert.equal(state.revision, backup.acknowledged.revision);
    assert.equal(backup.hashes['fixture.bin'], backup.acknowledged.fileHash);
  }
  async removeResources() {
    for (const [kind, name] of [...this.names].reverse()) {
      await this.owned(kind, name);
      await this.docker(kind === 'volume' ? ['volume', 'rm', name] : ['rm', '-f', name]);
      const listed = await this.docker(kind === 'volume' ? ['volume', 'ls', '--format', '{{.Name}}'] : ['ps', '-a', '--format', '{{.Names}}']);
      if (listed.split('\n').includes(name)) throw new Error('resource deletion not confirmed');
    }
    this.names = [];
  }
  async destroy() {
    const start = now();
    this.metrics.sourceVolumes = [...this.volumes];
    await this.removeResources();
    this.metrics.destroyMs = now() - start;
    return { containersDeleted: true, volumesDeleted: true };
  }
  async restore(backup) {
    await this.validate(backup);
    const start = now();
    await this.create(`restored-${randomBytes(4).toString('hex')}`);
    for (const name of FILES.slice(0, 2)) await this.docker(['cp', join(backup.root, name), `${this.runtime}:/workspace/${name}`]);
    await this.docker(['cp', join(backup.root, 'database.sql'), `${this.db}:/tmp/database.sql`]);
    await this.docker(['exec', this.db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fixture', '-d', 'fixture', '-f', '/tmp/database.sql']);
    await this.start();
    this.metrics.restoreToHealthMs = now() - start;
    this.metrics.restoredVolumes = [...this.volumes];
    const nodeKey = `${this.generation}ContainerId`;
    if (this.metrics.sourceContainerId) assert.notEqual(this.metrics[nodeKey], this.metrics.sourceContainerId);
    await this.read();
    await this.measure('restored');
  }
  async measure(phase) {
    const timings = [];
    for (let i = 0; i < 20; i++) {
      const start = now();
      const health = await this.http('/health');
      timings.push(now() - start);
      this.metrics[`${phase}NodeRssBytes`] = health.rssBytes;
    }
    this.metrics[`${phase}WarmHealthMs`] = timings;
    this.metrics[`${phase}DockerStats`] = await this.docker(['stats', '--no-stream', '--format', '{{json .}}', this.runtime, this.db]);
  }
  async mutate() {
    await this.http('/mutate', 'POST');
    await this.sql('UPDATE fixture SET revision = revision + 1;');
    const result = await this.read();
    assert.match(result.rows, /^1000:2000:/, 'SQL acknowledged mutation incomplete');
    return result;
  }
  async cleanup() { await this.removeResources(); }
}

export async function prepareCheckpointRoot(options) {
  if (!options['--checkpoint-root']) return mkdtemp(join(tmpdir(), 'matrix-checkpoints-'));
  const root = resolve(options['--checkpoint-root']);
  if (!options['--save-only'] && !options['--restore-only']) await mkdir(root, { mode: 0o700 });
  return root;
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = ['--output', '--checkpoint-root', '--save-only', '--restore-only'];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!allowed.includes(args[i])) throw new Error('unknown option');
    const flag = args[i];
    options[flag] = flag.endsWith('-only') ? true : args[++i];
    if (!options[flag]) throw new Error('option needs value');
  }
  if (options['--save-only'] && options['--restore-only']) throw new Error('conflicting modes');
  if ((options['--save-only'] || options['--restore-only']) && !options['--checkpoint-root']) throw new Error('checkpoint-root required');
  const root = await prepareCheckpointRoot(options);
  const evidence = { observedAt: new Date().toISOString(), workload: 'synthetic Node file API + 1000 Postgres rows; no Matrix gateway/agent', checkpointRoot: root, cycles: [] };
  const probe = new DockerFixture({ checkpointRoot: root });
  evidence.dockerVersion = await probe.docker(['version', '--format', '{{.Server.Version}}']);
  for (const image of ['node:24-bookworm-slim', 'postgres:17-bookworm']) {
    await probe.docker(['pull', image], { timeout: 300_000 });
  }
  evidence.images = await probe.docker(['image', 'inspect', 'node:24-bookworm-slim', 'postgres:17-bookworm', '--format', '{{.Id}} {{json .RepoDigests}}']);
  if (options['--restore-only']) {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const backup = { ...manifest, root };
    const adapter = new DockerFixture({ checkpointRoot: root, owner: backup.owner, size: backup.size });
    await adapter.restore(backup);
    const restored = await adapter.read();
    assert.deepEqual(restored, backup.acknowledged, 'restored state mismatch');
    const mutated = await adapter.mutate();
    verifyMutationState(backup.acknowledged, mutated);
    await adapter.cleanup();
    evidence.cycles.push({ restored, mutated, metrics: adapter.metrics, cleanup: true });
  } else if (options['--save-only']) {
    const adapter = new DockerFixture({ checkpointRoot: root });
    const acknowledged = await adapter.seed();
    const backup = await adapter.checkpoint(acknowledged);
    await adapter.validate(backup);
    const deletion = await adapter.destroy();
    evidence.cycles.push({ acknowledged, deletion, metrics: adapter.metrics, checkpointRetained: true });
  } else {
    for (const size of [1024 * 1024, 16 * 1024 * 1024]) for (let cycle = 1; cycle <= 3; cycle++) {
      const adapter = new DockerFixture({ checkpointRoot: join(root, `${size}-${cycle}`), size });
      const result = await runCycle(adapter);
      evidence.cycles.push({ size, cycle, ...result, metrics: adapter.metrics, cleanup: true });
    }
  }
  const output = JSON.stringify(evidence, null, 2);
  if (options['--output']) await writeFile(resolve(options['--output']), output, { mode: 0o600 });
  console.log(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  console.error('Benchmark stopped; resources/checkpoint retained for inspection. Delete only resources labeled matrix.spike on the disposable host.', error);
  process.exitCode = 1;
});
