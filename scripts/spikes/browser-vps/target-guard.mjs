import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Read classification, never source the host environment or expose its secrets. */
export function assertBrowserLabTarget(hostEnvironment, expectedHandle) {
  const handles = hostEnvironment.split(/\r?\n/).filter((line) => line.startsWith('MATRIX_HANDLE='));
  const classifications = hostEnvironment.split(/\r?\n/).filter((line) => line.startsWith('MATRIX_RUNTIME_SLOT='));
  if (!/^pr-[1-9][0-9]{0,9}$/.test(expectedHandle)
    || handles.length !== 1 || handles[0] !== `MATRIX_HANDLE=${expectedHandle}`
    || classifications.length !== 1 || classifications[0] !== `MATRIX_RUNTIME_SLOT=${expectedHandle}`) {
    throw new Error('Target is not the confirmed disposable preview');
  }
  return expectedHandle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertBrowserLabTarget(await readFile('/opt/matrix/env/host.env', 'utf8'), process.argv[2]);
    console.log('Disposable preview target verified');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Target validation failed');
    process.exitCode = 1;
  }
}
