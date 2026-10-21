import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Read classification, never source the host environment or expose its secrets. */
export function assertBrowserLabTarget(hostEnvironment, expectedHandle, machineId, ownerId) {
  const handles = hostEnvironment.split(/\r?\n/).filter((line) => line.startsWith('MATRIX_HANDLE='));
  const classifications = hostEnvironment.split(/\r?\n/).filter((line) => line.startsWith('MATRIX_RUNTIME_SLOT='));
  const legacy = /^pr-[1-9][0-9]{0,9}$/.test(expectedHandle) && machineId === undefined && ownerId === undefined;
  const values = (key) => hostEnvironment.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
  const exact = (key, value) => {
    const matches = values(key);
    return matches.length === 1 && matches[0] === `${key}=${value}`;
  };
  const projections = values('MATRIX_USER_ID');
  const privatePreview = /^pv-[1-9][0-9]{0,8}-[0-9a-f]{8}$/.test(expectedHandle)
    && typeof machineId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(machineId)
    && typeof ownerId === 'string' && /^user_[A-Za-z0-9]{1,128}$/.test(ownerId)
    && exact('MATRIX_MACHINE_ID', machineId) && exact('MATRIX_CLERK_USER_ID', ownerId)
    && (projections.length === 0 || exact('MATRIX_USER_ID', ownerId));
  if (!(legacy || privatePreview)
    || handles.length !== 1 || handles[0] !== `MATRIX_HANDLE=${expectedHandle}`
    || classifications.length !== 1 || classifications[0] !== `MATRIX_RUNTIME_SLOT=${expectedHandle}`) {
    throw new Error('Target is not the confirmed disposable preview');
  }
  return expectedHandle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (![3, 5].includes(process.argv.length)) throw new Error('Expected preview [machine-id owner-id]');
    assertBrowserLabTarget(await readFile('/opt/matrix/env/host.env', 'utf8'), ...process.argv.slice(2));
    console.log('Disposable preview target verified');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Target validation failed');
    process.exitCode = 1;
  }
}
