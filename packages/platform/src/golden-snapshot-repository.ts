/**
 * Golden snapshot persistence entrypoint (Phase 1-A4).
 *
 * Per-entity persistence moved to ./golden-snapshots/. Everything previously
 * imported from './golden-snapshot-repository.js' is re-exported below, so
 * existing importers are untouched.
 */
export * from './golden-snapshots/schemas.js';
export * from './golden-snapshots/mappers.js';
export * from './golden-snapshots/snapshots.js';
export * from './golden-snapshots/lifecycle.js';
export * from './golden-snapshots/builds.js';
export * from './golden-snapshots/leases.js';
export * from './golden-snapshots/rollout.js';
export * from './golden-snapshots/cleanup.js';
