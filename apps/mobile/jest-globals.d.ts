// TypeScript 6.0 (Expo SDK 57) stopped auto-including `@types/*` global
// declarations resolved through pnpm's symlinked typeRoots, so jest's globals
// (`describe`/`it`/`expect`/`jest`) went missing under `tsc --noEmit`. An
// explicit reference re-adds them project-wide without touching
// `compilerOptions.types` (which would opt out of every other auto-included type).
/// <reference types="jest" />
/// <reference types="node" />
