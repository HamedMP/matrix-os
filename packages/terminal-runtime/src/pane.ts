import { spawn } from 'node:child_process';

const SAFE_ENVIRONMENT_KEYS = [
  'HOME',
  'LANG',
  'MATRIX_HOME',
  'PATH',
  'TERM',
] as const;

export function paneEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export async function runPane(kind: string | undefined): Promise<number> {
  if (kind !== 'shell') return 64;
  return await new Promise<number>((resolve, reject) => {
    const child = spawn('/bin/bash', ['--login'], {
      cwd: process.cwd(),
      env: paneEnvironment(),
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error: Error) => reject(error));
    child.once('exit', (code, signal) => {
      if (signal !== null) resolve(128);
      else resolve(code ?? 1);
    });
  });
}

if (process.argv[1]?.endsWith('/pane.js')) {
  process.exitCode = await runPane(process.argv[2]);
}
