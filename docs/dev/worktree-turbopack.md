# Git Worktrees + pnpm + Turbopack

Discovered 2026-04-12 during spec 062 Docker verification. This doc explains a module resolution failure that only occurs in git worktrees and how we defend against it.

## The Problem

When running `next dev` (Turbopack) from a git worktree, every page returns HTTP 500 with:

```
Module not found: Can't resolve '@clerk/shared/authorization'
Module not found: Can't resolve './_MapCache.js'   (lodash-es)
```

The same code works fine from the main repo checkout.

## Root Cause

Three systems interact badly:

### 1. pnpm creates absolute symlinks

pnpm's virtual store (`.pnpm/`) uses **absolute symlinks** for inter-package dependencies. When `@clerk/backend` depends on `@clerk/shared`, pnpm creates:

```
node_modules/.pnpm/@clerk+backend@.../node_modules/@clerk/shared
  -> /Users/you/dev/matrix-os/node_modules/.pnpm/@clerk+shared@.../node_modules/@clerk/shared
```

These symlinks point to wherever `pnpm install` first resolved the packages. In our case, every symlink targets the main repo (`matrix-os/`), not the worktree (`062-shared-apps/`).

This affects ALL packages, not just Clerk:

```
node_modules/react   -> /Users/you/dev/matrix-os/node_modules/.pnpm/react@19.2.3/...
node_modules/next    -> /Users/you/dev/matrix-os/node_modules/.pnpm/next@16.2.3/...
node_modules/hono    -> /Users/you/dev/matrix-os/node_modules/.pnpm/hono@4.12.8/...
```

### 2. Turbopack enforces a root boundary

Turbopack's `root` setting defines the filesystem boundary for module resolution. From the Next.js docs:

> "Turbopack uses the root directory to resolve modules. Files outside of the project root are not resolved."

Our config set `root: resolve(__dirname, "..")` which resolves to `062-shared-apps/`. But the symlinks target `matrix-os/` -- outside the root. So Turbopack can't follow them.

### 3. Wildcard subpath exports compound the issue

`@clerk/shared` uses wildcard exports in its `package.json`:

```json
{ "exports": { "./*": { "import": "./dist/runtime/*.mjs" } } }
```

Turbopack already has limited support for wildcard `*` patterns in subpath exports (see [vercel/next.js#66887](https://github.com/vercel/next.js/issues/66887), [#88540](https://github.com/vercel/next.js/issues/88540)). Combined with symlinks outside the root, resolution fails completely.

## Why pnpm symlinks point to the main repo

Git worktrees share the same `.git` history but have independent working trees. `node_modules/` is gitignored, so each worktree should get its own via `pnpm install`.

However, pnpm uses a global content-addressable store (`~/Library/pnpm/store/v10/`). When you run `pnpm install` in the worktree with the same lockfile as the main repo, pnpm resolves packages from the shared store and creates symlinks with absolute paths pointing back to the main repo's `.pnpm/` entries -- where those packages were first linked.

The worktree's `.pnpm/` directory exists and contains real files (different inodes from the main repo), but the cross-package symlinks inside it reference the main repo path.

## What breaks if packages diverge

If the main repo adds, removes, or upgrades a package that the worktree hasn't:

- **Symlinks become dangling** -- they point to package versions that no longer exist in the main repo's `node_modules`
- **Wrong versions resolve** -- the worktree uses whatever the main repo has installed, ignoring the worktree's own lockfile
- **`pnpm install` in main breaks the worktree** -- adding a package in main and re-running install can shuffle the `.pnpm` directory layout, breaking the worktree's symlinks

This is a real risk for long-lived worktrees. Short-lived worktrees (branch work, then merge) are less affected.

## The Fix

### `findTurbopackRoot()` in next.config.ts

Detects worktrees by reading the `.git` file (worktrees have a file, not a directory) and widens the Turbopack root to encompass both the worktree and the main repo:

```ts
function findTurbopackRoot(): string {
  const projectRoot = resolve(__dirname, "..");
  try {
    const gitRef = readFileSync(resolve(projectRoot, ".git"), "utf8").trim();
    if (gitRef.startsWith("gitdir:")) {
      // gitdir: /path/to/main/.git/worktrees/name -> main is 3 levels up
      const mainRoot = resolve(gitRef.slice(8).trim(), "../../..");
      // Find common parent directory
      const p1 = projectRoot.split("/");
      const p2 = mainRoot.split("/");
      let i = 0;
      while (i < p1.length && i < p2.length && p1[i] === p2[i]) i++;
      return p1.slice(0, i).join("/") || "/";
    }
  } catch {}
  return projectRoot;
}
```

Behavior by environment:

| Environment | `.git` | Turbopack root |
|-------------|--------|----------------|
| Main repo | directory | `matrix-os/` (project root) |
| Worktree | file with `gitdir:` | `claude-tools/` (common parent) |
| Docker | doesn't exist | `/app` (project root) |

### `resolveAlias` for lodash-es

`lodash-es` uses internal relative imports (`./_MapCache.js`) that Turbopack can't resolve through pnpm symlinks. The alias redirects to the CJS `lodash` package:

```ts
turbopack: {
  resolveAlias: { "lodash-es": "lodash" },
}
```

This works because `lodash` and `lodash-es` export the same API. The alias only affects the dev bundler -- production builds (Vercel) don't hit this path.

`lodash` must be a direct dependency at the root `package.json` level (not just in `shell/`) so that pnpm hoists it to `node_modules/lodash` where Turbopack can find it from any importing package's context.

## Best Practices for Worktrees

1. **Nuke and reinstall after creating a worktree.** Run `rm -rf node_modules && pnpm install` in the worktree to get local symlinks. This may or may not fix the absolute-path issue depending on pnpm version and store state.

2. **Keep worktrees short-lived.** Merge and delete the worktree before the main repo's packages diverge too far. The longer a worktree lives, the more likely its symlinks become stale.

3. **Don't share `node_modules` Docker volumes across worktrees.** Each worktree's Docker setup should use its own `dev-node-modules` volume. Name them per-worktree to avoid collisions.

4. **After adding dependencies, update Docker.** Run `pnpm install` inside the Docker container (or recreate the `dev-node-modules` volume) to pick up new packages. The entrypoint's lockfile-hash check should handle this automatically, but `--force` may be needed.

## References

- [Next.js turbopack.root docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory)
- [vercel/next.js#66887](https://github.com/vercel/next.js/issues/66887) -- Turbopack can't resolve wildcard subpath exports
- [vercel/next.js#88540](https://github.com/vercel/next.js/issues/88540) -- resolveAlias doesn't resolve subpath exports for transitive deps
- [vercel/next.js#68805](https://github.com/vercel/next.js/issues/68805) -- Turbopack can't locate pnpm child dependencies
