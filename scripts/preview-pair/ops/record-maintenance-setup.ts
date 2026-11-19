/** Record the actual normal-profile setup response; never synthesize an auth proof. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.MATRIX_PREVIEW_CANDIDATE_ROOT;
const sha = process.env.MATRIX_PREVIEW_CANDIDATE_SHA;
const profile = process.argv[2];
if (!root || !sha || !/^[a-f0-9]{40}$/.test(sha) || !profile) throw new Error('Set candidate ROOT/SHA and pass your normal control profile');
const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
if (actual !== sha || execFileSync('git', ['-C',root,'status','--porcelain'], { encoding:'utf8',timeout:10_000 }).trim()) throw new Error('Candidate checkout must be clean at the exact SHA');
const { previewPairUserControl } = await import(pathToFileURL(resolve(root, 'scripts/preview-pair/control.ts')).href);
const setup = await (await previewPairUserControl(profile)).setup();
if (setup.admissionEnabled !== false || setup.controllerSha !== 'bc47e8e3623898f83c946d13f0689e572b9a3821') throw new Error('Expected maintenance-only setup and reviewed controller');
await writeFile(new URL('./source-maintenance-setup-receipt.json', import.meta.url), JSON.stringify({
  checkedAt: new Date().toISOString(), normalUserSetupPassed: true,
  admissionEnabled: setup.admissionEnabled, controllerSha: setup.controllerSha, candidateSha: sha,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Recorded successful closed-admission setup using the normal control profile.');
