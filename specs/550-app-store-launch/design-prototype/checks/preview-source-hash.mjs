import { createHash } from 'node:crypto';
export function previewSourceHash(inputs) {
 return createHash('sha256').update(JSON.stringify(inputs).replaceAll('<', '\\u003c')).digest('hex');
}
