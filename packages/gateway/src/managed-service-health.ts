import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Health = { shell: boolean; syncAgent: boolean };
type Run = (file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8' }) => Promise<{ stdout: string }>;

/** One expiring entry, shared across info requests. No shell interpolation, user
 * arguments, unbounded output, or dependency on a privileged systemd mutation. */
export function createManagedServiceHealth(options: { run?: Run } = {}) {
  const run: Run = options.run ?? promisify(execFile);
  let cached: { value: Health; until: number } | undefined;
  let pending: Promise<Health> | undefined;
  return async (): Promise<Health> => {
    if (cached && cached.until > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value: Health = { shell: false, syncAgent: false };
      try {
        const { stdout } = await run('/usr/bin/systemctl', ['is-active', 'matrix-shell.service', 'matrix-sync-agent.service'], { timeout: 5000, maxBuffer: 4096, encoding: 'utf8' });
        const states = stdout.trim().split('\n');
        value = { shell: states[0] === 'active', syncAgent: states[1] === 'active' };
      } catch (err: unknown) {
        console.warn('[managed-health] Host services unavailable', err instanceof Error ? err.name : typeof err);
      }
      cached = { value, until: Date.now() + 5000 };
      return value;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
