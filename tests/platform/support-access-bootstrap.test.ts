import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../../distro/customer-vps/host-bin/matrix-support-access');

function withGeneratedKey(run: (publicKeyPath: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-support-key-'));
  try {
    const privateKeyPath = join(directory, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKeyPath]);
    run(`${privateKeyPath}.pub`, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('support SSH key bootstrap validation', () => {
  it('accepts one ordinary Ed25519 public key', () => {
    withGeneratedKey((publicKeyPath) => {
      const result = spawnSync('bash', [helper, '--validate-key', publicKeyPath], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('valid');
    });
  });

  it('rejects authorized_keys options, extra keys, and malformed key bytes', () => {
    withGeneratedKey((publicKeyPath, directory) => {
      const valid = readFileSync(publicKeyPath, 'utf8').trim();
      for (const [name, contents] of [
        ['options', `command="id" ${valid}\n`],
        ['multiple', `${valid}\n${valid}\n`],
        ['malformed', 'ssh-ed25519 AAAA invalid\n'],
        ['injection', `${valid}\nPermitRootLogin yes\n`],
      ]) {
        const candidate = join(directory, name);
        writeFileSync(candidate, contents);
        const result = spawnSync('bash', [helper, '--validate-key', candidate], { encoding: 'utf8' });
        expect(result.status, name).not.toBe(0);
      }
    });
  });

  it('renders a two-key rotation and rejects reusing the old key', () => {
    withGeneratedKey((oldKey, directory) => {
      const candidatePrivate = join(directory, 'candidate_ed25519');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', candidatePrivate]);
      const candidateKey = `${candidatePrivate}.pub`;
      const result = spawnSync('bash', [helper, '--validate-rotation', oldKey, candidateKey], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${readFileSync(oldKey, 'utf8')}${readFileSync(candidateKey, 'utf8')}`);

      const reused = spawnSync('bash', [helper, '--validate-rotation', oldKey, oldKey], { encoding: 'utf8' });
      expect(reused.status).not.toBe(0);
    });
  });

  it('has a fixed, root-owned source and does not copy root authorized_keys', () => {
    const source = readFileSync(helper, 'utf8');
    expect(source).toContain('/etc/matrix/support/public-key');
    expect(source).not.toContain('/root/.ssh/authorized_keys');
    expect(source).toContain('matrix-support');
    expect(source).toContain('visudo -cf');
  });

  it('ships an executable helper in customer host bundles', () => {
    const buildScript = readFileSync(resolve(import.meta.dirname, '../../scripts/build-host-bundle.sh'), 'utf8');
    expect(buildScript).toContain('"$STAGE_DIR/bin/matrix-support-access"');
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });
});
