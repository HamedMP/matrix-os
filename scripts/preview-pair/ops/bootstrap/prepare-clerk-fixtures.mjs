// Bootstrap/recovery only: read ../README.md; resources already exist.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const instanceId = process.env.MATRIX_PREVIEW_CLERK_INSTANCE_ID;
const issuer = process.env.MATRIX_PREVIEW_CLERK_ISSUER;
const secret = execFileSync('gcloud', ['secrets', 'versions', 'access', '1',
  '--secret=matrix-pair-preview-clerk-secret', '--project=matrix-os-1144'],
  { encoding: 'utf8', timeout: 15_000 }).trim();
if (!/^sk_test_[A-Za-z0-9_=-]{1,500}$/.test(secret)) throw new Error('Expected a dedicated development credential');

async function request(path, body, allowMissing = false) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const codes = (failure?.errors ?? []).map(item => item.code)
      .filter(code => typeof code === 'string' && /^[a-z0-9_]{1,100}$/.test(code)).slice(0, 4);
    throw new Error(`Dedicated fixture operation failed (${response.status}; ${codes.join(',')})`);
  }
  return response.json();
}

if (!instanceId || !issuer) throw new Error('Set the reviewed dedicated Clerk instance ID and issuer');
const instance = await request('/instance');
if (instance.id !== instanceId || instance.environment_type !== 'development') {
  throw new Error('Credential is not for the newly created dedicated development instance');
}
const listed = await request('/users?limit=100');
if (!Array.isArray(listed) || listed.length > 3) throw new Error('Unexpected dedicated instance user inventory');
const actors = {};
for (const role of ['owner', 'member', 'outsider']) {
  const externalId = `eng-418-pair-${role}-v1`;
  const email = `matrix-preview-${role}+clerk_test@example.com`;
  const matches = listed.filter(user => user.external_id === externalId);
  if (matches.length > 1) throw new Error('Duplicate fixture actor');
  const user = matches[0] ?? await request('/users', {
    external_id: externalId, email_address: [email], first_name: 'Preview',
    last_name: role[0].toUpperCase() + role.slice(1), skip_password_requirement: true,
  });
  if (!/^user_[A-Za-z0-9]+$/.test(user.id)) throw new Error('Unexpected actor identity');
  actors[role] = { id: user.id, email };
}
const organizations = await request('/organizations?limit=10');
if (organizations.total_count > 1) throw new Error('Unexpected dedicated organization inventory');
const existing = organizations.data.filter(item => item.private_metadata?.fixture === 'pair-fixture-1');
if (existing.length > 1 || organizations.total_count !== existing.length) throw new Error('Unrecognized dedicated organization');
// New Clerk instances disable organization slugs by default. Use its real ID;
// the pair contract and membership checks do not require or change slug policy.
const organization = existing[0] ?? await request('/organizations', {
  name: 'Matrix OS Collaboration Preview', created_by: actors.owner.id,
  private_metadata: { purpose: 'eng-418-preview', fixture: 'pair-fixture-1' },
});
if (!/^org_[A-Za-z0-9]+$/.test(organization.id)) throw new Error('Unexpected organization identity');
let memberships = await request(`/organizations/${organization.id}/memberships?limit=10`);
if (!memberships.data.some(item => item.public_user_data?.user_id === actors.member.id)) {
  await request(`/organizations/${organization.id}/memberships`, { user_id: actors.member.id, role: 'org:member' });
}
memberships = await request(`/organizations/${organization.id}/memberships?limit=10`);
const memberIds = memberships.data.map(item => item.public_user_data?.user_id).sort();
const expected = [actors.owner.id, actors.member.id].sort();
if (memberships.total_count !== 2 || JSON.stringify(memberIds) !== JSON.stringify(expected)) {
  throw new Error('Dedicated organization membership differs from the expected pair');
}
const outsider = await request(`/users/${actors.outsider.id}/organization_memberships?limit=10`);
if (outsider.total_count !== 0) throw new Error('Outsider must have no organization membership');
const result = { instanceId, issuer, actors, organizationId: organization.id,
  fixture: { id: 'pair-fixture-1', ownerActorId: actors.owner.id,
    memberActorId: actors.member.id, outsiderActorId: actors.outsider.id, organizationId: organization.id },
  verification: { realClerk: true, organizationMembers: 2, outsiderOrganizations: 0, sessionsInjected: false } };
await writeFile(new URL('./fixtures.json', import.meta.url), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ instanceVerified: true, actors: Object.keys(actors), organizationMembers: 2, outsiderOrganizations: 0 }));
