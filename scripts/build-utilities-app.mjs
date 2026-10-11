#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'packages/utilities-runtime');
const { build, createServer } = await import(pathToFileURL(join(runtime, 'node_modules/vite/dist/node/index.js')).href);
const { default: tailwind } = await import(pathToFileURL(join(runtime, 'node_modules/@tailwindcss/vite/dist/index.mjs')).href);
const dependencies = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies;
const aliases = Object.keys(dependencies).filter((name) => !['@matrix-os/brand', 'vite', 'tailwindcss', '@tailwindcss/vite'].includes(name))
  .map((name) => ({ find: name, replacement: join(runtime, 'node_modules', name) }));
aliases.unshift({ find: '@matrix-os/brand', replacement: join(root, 'packages/brand/src/index.ts') });
const config = {
  configFile: false,
  root: process.env.MATRIX_UTILITIES_APP_DIR ?? join(root, 'home/apps/utilities'),
  base: './',
  plugins: [tailwind()],
  resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4317, strictPort: true },
};
if (process.argv.includes('--dev')) {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
} else await build(config);
