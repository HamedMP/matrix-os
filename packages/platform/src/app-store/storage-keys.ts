import { AppStoreError } from './errors.js';
function ownerPrefix(owner: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(owner)) throw new AppStoreError('invalid');
  return `app-store/owners/${owner}`;
}
export const storeUploadKey = (owner: string, versionId: string) => `${ownerPrefix(owner)}/uploads/${versionId}`;
export const storeSourceKey = (owner: string, versionId: string, sha256: string) => `${ownerPrefix(owner)}/sources/${versionId}/${sha256}`;
