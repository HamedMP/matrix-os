import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const workflow = readFileSync(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8');
/** Every read-only fleet lookup: the curl command up to the URL it fetches. */
const lookups = [...workflow.matchAll(/curl ([^|]*?)"\$\{PLATFORM_PUBLIC_URL\}\/vps\/fleet"/g)].map(match => match[1]!);
const flags = (command: string) => {
  const parts = command.replace(/\\\n/g, ' ').split(/\s+/);
  return parts.flatMap((part, index) => !part.startsWith('--retry') ? [] : part === '--retry-all-errors' ? [part] : [part, parts[index + 1]!]);
};

describe('preview fleet lookups', () => {
  it('retries every fleet lookup, so one bad platform response does not fail a finished deploy', () => {
    expect(lookups.length).toBeGreaterThanOrEqual(6);
    for (const lookup of lookups) {
      expect(lookup).toContain('--retry 3');
      // Plain --retry ignores edge errors such as HTTP 520; these lookups are idempotent reads.
      expect(lookup).toContain('--retry-all-errors');
    }
  });

  it('recovers from an edge 520 with exactly the flags the workflow uses', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      if (requests === 1) { response.statusCode = 520; response.end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end('{"machines":[]}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vps/fleet`;
      const { stdout } = await run('curl', ['-fsS', '--max-time', '10', ...flags(lookups[0]!), '--retry-delay', '0', url]);
      expect(JSON.parse(stdout)).toEqual({ machines: [] });
      expect(requests).toBe(2);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
